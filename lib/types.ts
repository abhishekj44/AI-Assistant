export enum FLAGS {
  COPILOT = "copilot",
  SUMMERIZER = "summerizer",
}

export interface HistoryData {
  createdAt: string;
  data: string;
  tag: string;
}

export interface ExtractedQuestion {
  question: string;
  context: string;
  confidence: number;
}

