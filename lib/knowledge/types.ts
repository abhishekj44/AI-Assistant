export type KnowledgeDocumentType = "resume" | "job_description" | "project" | "notes" | "other";

export interface CandidateExperience {
  company?: string;
  role?: string;
  period?: string;
  responsibilities: string[];
  achievements: string[];
  technologies: string[];
}

/**
 * A compact, source-supported project example that can be injected into a live answer without
 * sending the full project record. `answerHooks` are retrieval metadata only; they are never
 * presented to the model as candidate facts.
 */
export interface CandidateProjectExample {
  title: string;
  situation?: string;
  approach?: string;
  result?: string;
  relevance?: string[];
}

export interface CandidateProject {
  name: string;
  problem?: string;
  role?: string;
  architecture?: string;
  technologies: string[];
  decisions: Array<{ decision: string; reason?: string; tradeoffs?: string[] }>;
  challenges: Array<{ challenge: string; solution?: string; result?: string }>;
  metrics: string[];
  lessons: string[];
  /** Search-only hints derived from source terminology; not factual claims sent to the LLM. */
  answerHooks?: string[];
  /** Short source-supported examples used when a project is relevant to the live question. */
  examples?: CandidateProjectExample[];
}

export interface KnowledgeContribution {
  profile?: { headline?: string; summary?: string; strengths?: string[] };
  targetRole?: { title?: string; company?: string; priorities?: string[]; requirements?: string[] };
  experience?: CandidateExperience[];
  projects?: CandidateProject[];
  skills?: string[];
  achievements?: string[];
  facts?: string[];
}

export interface KnowledgeSource {
  id: string;
  filename: string;
  type: KnowledgeDocumentType;
  uploadedAt: string;
  summary: string;
  facts: string[];
  keywords: string[];
  rawExcerpt?: string;
  contribution?: KnowledgeContribution;
}

export interface CandidateKnowledgePack {
  version: number;
  updatedAt: string;
  profile: {
    headline?: string;
    summary?: string;
    strengths: string[];
  };
  targetRole?: {
    title?: string;
    company?: string;
    priorities: string[];
    requirements: string[];
  };
  experience: CandidateExperience[];
  projects: CandidateProject[];
  skills: string[];
  achievements: string[];
  facts: string[];
  sources: KnowledgeSource[];
}

export const EMPTY_KNOWLEDGE_PACK: CandidateKnowledgePack = {
  version: 2,
  updatedAt: new Date(0).toISOString(),
  profile: { strengths: [] },
  experience: [],
  projects: [],
  skills: [],
  achievements: [],
  facts: [],
  sources: [],
};
