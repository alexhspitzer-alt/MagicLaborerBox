const API = 'https://en.wikibooks.org/w/api.php';
const MAX_SEARCHES = 12;
const MAX_VERDICT_ATTEMPTS = 3;

type Hit = { pageid: number; title: string };
type SearchResult = { query?: { search: Hit[] }; continue?: { sroffset: number; continue: string } };
type ParsedPage = { parse?: { text: string } };
type Report = (message: string, page?: { title: string; url: string }) => void;

async function request<T>(parameters: Record<string, string>): Promise<T> {
  const query = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...parameters });
  const response = await fetch(`${API}?${query}`, {
    cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Wikibooks returned HTTP ${response.status}.`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.info || 'Wikibooks could not complete the request.');
  return data;
}

function readIngredients(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  let sectionLevel = 0;
  const lines: string[] = [];
  for (const node of template.content.querySelectorAll('h2, h3, h4, h5, h6, li, p')) {
    const level = /^H[2-6]$/.test(node.tagName) ? Number(node.tagName[1]) : 0;
    if (level) {
      if (sectionLevel && level <= sectionLevel) break;
      if (/^ingredients$/i.test(node.textContent.trim())) sectionLevel = level;
    } else if (sectionLevel && !node.closest('table, nav, .mw-editsection') && !node.parentElement?.closest('li')) {
      const line = node.textContent.trim();
      if (line) lines.push(line);
    }
  }
  return lines.join('\n');
}

function parseVerdict(answer: string): 'YES' | 'NO' | undefined {
  const cleaned = answer.replace(/[`*_~"'“”‘’]/g, '').trim()
    .replace(/^\s*(?:[-•>]+\s+)?(?:(?:answer|verdict|result)\s*[:=-]\s*)?\(?\s*/i, '');
  const verdict = /^(yes|no)(?=\s*(?:[.!,:;)\n–—-]|$))/i.exec(cleaned)?.[1].toUpperCase();
  if (verdict === 'YES' || verdict === 'NO') return verdict;
}

export async function findRecipe(query: string, classify: (ingredient: string, attempt: number) => Promise<string>, report: Report): Promise<(Hit & { ingredients: string }) | null> {
  const seen = new Set<number>();
  let cursor: SearchResult['continue'];
  for (let attempt = 1; attempt <= MAX_SEARCHES; attempt++) {
    report(`Search ${attempt} · ${query}`);
    const search = await request<SearchResult>({
      action: 'query', list: 'search', srnamespace: '102', srlimit: '1', srsearch: `intitle:${JSON.stringify(query)}`,
      ...(cursor && { sroffset: String(cursor.sroffset), continue: cursor.continue }),
    });
    const hit = search.query?.search[0];
    if (!hit) return null;
    cursor = search.continue;
    if (!seen.has(hit.pageid)) {
      seen.add(hit.pageid);
      const page = { title: hit.title.replace(/^Cookbook:/, ''), url: `https://en.wikibooks.org/?curid=${hit.pageid}` };
      report('Reading', page);
      const article = await request<ParsedPage>({ action: 'parse', pageid: String(hit.pageid), prop: 'text' });
      const ingredients = readIngredients(article.parse?.text ?? '');
      if (ingredients) {
        const lines = ingredients.split('\n').map(line => line.trim()).filter(Boolean);
        let allNo = true;
        for (const ingredient of lines) {
          let verdict: ReturnType<typeof parseVerdict>;
          for (let attempt = 1; attempt <= MAX_VERDICT_ATTEMPTS; attempt++) {
            const answer = await classify(ingredient, attempt);
            verdict = parseVerdict(answer);
            if (verdict) break;
            const next = attempt < MAX_VERDICT_ATTEMPTS ? 'Retrying ingredient' : 'Skipping recipe after three attempts';
            report(`${next} · ${ingredient} · unexpected reply ${JSON.stringify(answer.trim())}`, page);
          }
          if (verdict === 'NO') continue;
          if (verdict === 'YES') report(`YES · ${ingredient}`, page);
          allNo = false;
          break;
        }
        if (allNo) {
          report(`NO · all ${lines.length} ingredients checked`, page);
          return { ...hit, ingredients };
        }
      } else {
        report('Skipped page without an ingredient list', page);
      }
    }
    if (!cursor) return null;
  }
  return null;
}
