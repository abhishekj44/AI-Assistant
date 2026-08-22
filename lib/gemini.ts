import { GoogleGenAI } from "@google/genai";

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
/** Lighter fallback model used when the primary model is overloaded. */
export const GEMINI_MODEL_FAST = "gemini-3.5-flash-lite";
export const GEMINI_FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default gemini;
