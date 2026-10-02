import { z } from "zod";
import type { Plugin, Tool } from "../types.js";

/** Typed helpers — they only exist so `args` gets inferred from the schema. */
export const defineTool = <S extends z.ZodType>(t: Tool<S>) => t;
export const definePlugin = (p: Plugin) => p;
export { z };
