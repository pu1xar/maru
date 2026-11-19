// The timeline entry a find in the thread shows (DESIGN.md 6u). A row whose text a fold hides (a
// folded agent message, a long user message) opens while it is this entry.
import { createContext } from "react";

export const FindRevealContext = createContext<string | null>(null);
