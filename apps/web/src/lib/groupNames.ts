import { createContext } from "react";

/** Group (project) names by id, for the conversation header's first breadcrumb item (DESIGN.md 6c). */
export const GroupNamesContext = createContext<ReadonlyMap<string, string>>(new Map());
