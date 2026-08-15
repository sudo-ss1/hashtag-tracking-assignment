export type MediaSource = 'top' | 'recent';

export type IgMedia = {
  id: string;
  media_type: string;
  timestamp: string;
  permalink: string;
  media_url?: string;
  caption?: string;
  like_count?: number;
  comments_count?: number;
};

export type GraphPage = {
  data: IgMedia[];
  paging?: { cursors?: { after?: string }; next?: string };
};
