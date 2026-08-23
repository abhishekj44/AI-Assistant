export interface QAEntry {
  id: string;
  category?: string;
  questions: string[];
  answer: string;
  keyPoints: string[];
  tags: string[];
  personal: boolean;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QABank {
  version: number;
  updatedAt: string;
  entries: QAEntry[];
}

export interface QAMatch {
  entry: QAEntry;
  score: number;
  matchedQuestion?: string;
}

export const EMPTY_QA_BANK: QABank = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  entries: [],
};
