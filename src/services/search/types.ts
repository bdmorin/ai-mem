export interface SearchOptions {
  query?: string;
  mode: 'fts5' | 'vector' | 'hybrid';
  limit?: number;
  offset?: number;
  project?: string;
  type?: string | string[];
  dateStart?: number;
  dateEnd?: number;
  concepts?: string[];
  files?: string;
}

export interface SearchResult {
  id: number;
  score: number;
  mode: 'fts5' | 'vector' | 'hybrid';
  title: string;
  type: string;
  project: string;
  created_at_epoch: number;
}
