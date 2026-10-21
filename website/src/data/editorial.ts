import { clientDetails as clients, comparisonDetails as comparisons, guideDetails as guides,
  referenceLinks, reportDetails as reports } from "../../lib/collection-details.mjs";
import type { Article, ClientDetail, ReportDetail } from "../lib/types";
export { referenceLinks };
export const clientDetails = clients as Record<string, ClientDetail>;
export const guideDetails = guides as Record<string, string[]>;
export const comparisonDetails = comparisons as Record<string, string[]>;
export const reportDetails = reports as Record<string, ReportDetail>;
export function clientFor(article: Article): ClientDetail {
  return clientDetails[article.id] ?? { name: "Coding client", surface: "ACC integration", note: article.description };
}
