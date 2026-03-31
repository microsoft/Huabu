export interface WebLookupQuery {
  sourceId: string;
}

export interface WebPreviewResponse {
  url: string;
  title?: string;
  contentHtml?: string;
  summary?: string;
  image?: string;
  favicon?: string;
  siteName?: string;
}

export interface WebReaderResponse {
  url: string;
  title: string;
  html: string;
  contentMarkdown?: string;
  siteName?: string;
}
