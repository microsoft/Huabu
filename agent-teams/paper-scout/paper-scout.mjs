#!/usr/bin/env node

/* global AbortSignal, fetch */

import process from 'node:process';
import { URL } from 'node:url';

const OPENALEX_API = 'https://api.openalex.org';
const ARXIV_API = 'https://export.arxiv.org/api/query';
const CROSSREF_API = 'https://api.crossref.org';
const DEFAULT_LIMIT = 8;
const DEFAULT_SINCE = new Date().getUTCFullYear() - 5;
const HCI_VENUES = [
  {
    name: 'CHI EA',
    patterns: [/chi extended abstracts/i],
  },
  {
    name: 'CHI',
    patterns: [/human factors in computing systems/i, /\bchi conference\b/i],
  },
  {
    name: 'UIST',
    patterns: [/user interface software and technology/i, /\buist\b/i],
  },
  {
    name: 'CSCW',
    patterns: [/computer[- ]supported cooperative work/i, /\bcscw\b/i],
  },
  {
    name: 'DIS',
    patterns: [/designing interactive systems/i, /\bdis conference\b/i],
  },
  {
    name: 'IUI',
    patterns: [/intelligent user interfaces/i, /\biui\b/i],
  },
  {
    name: 'PACM HCI',
    patterns: [/proceedings of the acm on human[- ]computer interaction/i],
  },
];

function printHelp() {
  process.stdout.write(`Usage:
  node paper-scout.mjs search "<query>" [--limit 8] [--since 2021] [--hci] [--source all|openalex|arxiv]
  node paper-scout.mjs doi "<doi>"

Environment:
  OPENALEX_API_KEY  Optional OpenAlex API key
  PAPER_SCOUT_EMAIL Optional contact email sent to OpenAlex and Crossref
`);
}

function fail(message) {
  process.stderr.write(`paper-scout: ${message}\n`);
  process.exitCode = 1;
}

function parseSearchArgs(args) {
  const options = {
    query: args[0],
    limit: DEFAULT_LIMIT,
    since: DEFAULT_SINCE,
    hci: false,
    source: 'all',
  };

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--hci') {
      options.hci = true;
    } else if (argument === '--limit') {
      options.limit = Number(args[++index]);
    } else if (argument === '--since') {
      options.since = Number(args[++index]);
    } else if (argument === '--source') {
      options.source = args[++index];
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!options.query) throw new Error('A search query is required');
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 25
  ) {
    throw new Error('--limit must be an integer from 1 to 25');
  }
  if (
    !Number.isInteger(options.since) ||
    options.since < 1900 ||
    options.since > 2100
  ) {
    throw new Error('--since must be a four-digit year');
  }
  if (!['all', 'openalex', 'arxiv'].includes(options.source)) {
    throw new Error('--source must be all, openalex, or arxiv');
  }
  return options;
}

async function request(url, accept = 'application/json') {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      'User-Agent': `Huabu-Paper-Scout/1.0${process.env.PAPER_SCOUT_EMAIL ? ` (mailto:${process.env.PAPER_SCOUT_EMAIL})` : ''}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText} from ${new URL(url).hostname}`,
    );
  }
  return response;
}

function reconstructAbstract(index) {
  if (!index) return null;
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.join(' ').trim() || null;
}

function normalizeDoi(value) {
  if (!value) return null;
  return value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
}

function normalizeTitle(value) {
  return (value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function openAlexVenue(work) {
  return (
    work.primary_location?.source?.display_name ||
    work.locations?.find((location) => location.source?.display_name)?.source
      ?.display_name ||
    null
  );
}

function classifyHciVenue(venue) {
  if (!venue) return null;
  return (
    HCI_VENUES.find(({ patterns }) =>
      patterns.some((pattern) => pattern.test(venue)),
    )?.name || null
  );
}

async function searchOpenAlex(options) {
  const url = new URL('/works', OPENALEX_API);
  url.searchParams.set('search', options.query);
  url.searchParams.set(
    'filter',
    `from_publication_date:${options.since}-01-01`,
  );
  url.searchParams.set(
    'per-page',
    String(Math.min(100, options.limit * (options.hci ? 6 : 3))),
  );
  url.searchParams.set(
    'select',
    'id,doi,title,display_name,publication_year,publication_date,authorships,primary_location,locations,open_access,best_oa_location,abstract_inverted_index,cited_by_count,type',
  );
  if (process.env.OPENALEX_API_KEY)
    url.searchParams.set('api_key', process.env.OPENALEX_API_KEY);
  if (process.env.PAPER_SCOUT_EMAIL)
    url.searchParams.set('mailto', process.env.PAPER_SCOUT_EMAIL);

  const response = await request(url);
  const body = await response.json();
  return body.results.map((work, rank) => {
    const doi = normalizeDoi(work.doi);
    const paper = {
      source: 'openalex',
      sourceId: work.id,
      title: work.display_name || work.title,
      authors: (work.authorships || [])
        .map((entry) => entry.author?.display_name)
        .filter(Boolean),
      year: work.publication_year,
      date: work.publication_date,
      venue: openAlexVenue(work),
      type: work.type,
      doi,
      url: doi ? `https://doi.org/${doi}` : work.id,
      openAccessUrl:
        work.best_oa_location?.pdf_url ||
        work.best_oa_location?.landing_page_url ||
        null,
      abstract: reconstructAbstract(work.abstract_inverted_index),
      citedByCount: work.cited_by_count ?? null,
      rank,
    };
    paper.hciVenue = classifyHciVenue(paper.venue);
    paper.hci = Boolean(paper.hciVenue);
    return paper;
  });
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlText(xml, tag) {
  const match = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  );
  return match
    ? decodeXml(
        match[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
    : null;
}

async function searchArxiv(options) {
  const url = new URL(ARXIV_API);
  const phrase = options.query
    .replace(/["()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const endYear = new Date().getUTCFullYear() + 1;
  url.searchParams.set(
    'search_query',
    `all:"${phrase}" AND submittedDate:[${options.since}01010000 TO ${endYear}01010000]`,
  );
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(Math.min(50, options.limit * 3)));
  url.searchParams.set('sortBy', 'relevance');

  const response = await request(url, 'application/atom+xml');
  const xml = await response.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map(
    (match, rank) => {
      const entry = match[1];
      const id = xmlText(entry, 'id');
      const published = xmlText(entry, 'published');
      const journalRef = xmlText(entry, 'arxiv:journal_ref');
      const doi = normalizeDoi(xmlText(entry, 'arxiv:doi'));
      const pdfMatch = entry.match(
        /<link[^>]+href="([^"]+)"[^>]+title="pdf"[^>]*\/?\s*>/i,
      );
      const paper = {
        source: 'arxiv',
        sourceId: id,
        title: xmlText(entry, 'title'),
        authors: [...entry.matchAll(/<author>([\s\S]*?)<\/author>/gi)]
          .map((author) => xmlText(author[1], 'name'))
          .filter(Boolean),
        year: published ? Number(published.slice(0, 4)) : null,
        date: published,
        venue: journalRef || 'arXiv',
        type: 'preprint',
        doi,
        url: doi ? `https://doi.org/${doi}` : id,
        openAccessUrl: pdfMatch
          ? decodeXml(pdfMatch[1])
          : id?.replace('/abs/', '/pdf/'),
        abstract: xmlText(entry, 'summary'),
        categories: [...entry.matchAll(/<category[^>]+term="([^"]+)"/gi)].map(
          (category) => category[1],
        ),
        citedByCount: null,
        rank,
      };
      paper.hciVenue = classifyHciVenue(paper.venue);
      paper.hci = Boolean(paper.hciVenue) || paper.categories.includes('cs.HC');
      return paper;
    },
  );
}

function mergePapers(papers, options) {
  const merged = new Map();
  for (const paper of papers) {
    const key = paper.doi
      ? `doi:${paper.doi}`
      : `title:${normalizeTitle(paper.title)}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, paper);
      continue;
    }
    const preferred = existing.source === 'openalex' ? existing : paper;
    const alternate = preferred === existing ? paper : existing;
    merged.set(key, {
      ...alternate,
      ...preferred,
      abstract: preferred.abstract || alternate.abstract,
      openAccessUrl: preferred.openAccessUrl || alternate.openAccessUrl,
      sources: [
        ...new Set([
          ...(existing.sources || [existing.source]),
          ...(paper.sources || [paper.source]),
        ]),
      ],
    });
  }

  return [...merged.values()]
    .sort((left, right) => {
      const hciDifference = options.hci
        ? Number(right.hci) - Number(left.hci)
        : 0;
      if (hciDifference) return hciDifference;
      const rankDifference = left.rank - right.rank;
      if (rankDifference) return rankDifference;
      return (right.citedByCount || 0) - (left.citedByCount || 0);
    })
    .slice(0, options.limit)
    .map((paper) => {
      const result = { ...paper };
      delete result.rank;
      return result;
    });
}

async function runSearch(args) {
  const options = parseSearchArgs(args);
  const jobs = [];
  if (options.source !== 'arxiv')
    jobs.push(['openalex', searchOpenAlex(options)]);
  if (options.source !== 'openalex') jobs.push(['arxiv', searchArxiv(options)]);

  const settled = await Promise.allSettled(jobs.map(([, job]) => job));
  const warnings = [];
  const papers = [];
  settled.forEach((result, index) => {
    const source = jobs[index][0];
    if (result.status === 'fulfilled') papers.push(...result.value);
    else warnings.push(`${source}: ${result.reason.message}`);
  });
  if (papers.length === 0)
    throw new Error(warnings.join('; ') || 'No search source returned results');

  process.stdout.write(
    `${JSON.stringify(
      {
        query: options.query,
        since: options.since,
        hciMode: options.hci,
        evidenceScope:
          'Metadata and abstracts only; openAccessUrl is not proof that full text was read.',
        warnings,
        papers: mergePapers(papers, options),
      },
      null,
      2,
    )}\n`,
  );
}

async function runDoi(doiArgument) {
  const doi = normalizeDoi(doiArgument);
  if (!doi) throw new Error('A DOI is required');
  const url = new URL(`/works/${encodeURIComponent(doi)}`, CROSSREF_API);
  if (process.env.PAPER_SCOUT_EMAIL)
    url.searchParams.set('mailto', process.env.PAPER_SCOUT_EMAIL);
  const response = await request(url);
  const item = (await response.json()).message;
  process.stdout.write(
    `${JSON.stringify(
      {
        doi: normalizeDoi(item.DOI),
        title: item.title?.[0] || null,
        authors: (item.author || []).map(({ given, family }) =>
          [given, family].filter(Boolean).join(' '),
        ),
        published: item.published?.['date-parts']?.[0] || null,
        venue: item['container-title']?.[0] || null,
        publisher: item.publisher || null,
        type: item.type || null,
        url: item.URL || `https://doi.org/${doi}`,
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'search') await runSearch(args);
  else if (command === 'doi') await runDoi(args[0]);
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => fail(error.message));
