export type SectionId = "guides" | "integrations" | "compare" | "research" | "reports" | "docs";
export type ArticleType = "guide" | "integration" | "comparison" | "comparison-hub" | "research" | "report" | "doc" | "reference";
export type PageKind = "home" | "collection" | "article" | "search" | "error";
export interface Heading { id: string; text: string; }
export interface ArticleSection extends Heading { headingHtml: string; bodyHtml: string; html: string; hasTable: boolean; }
export interface Article {
  id: string; title: string; description: string; route: string; type: ArticleType;
  section: SectionId; language: string; author: string; lastVerified: string;
  accVersion: string; evidenceLevel: string; status: "reviewed"; filename: string;
  introHtml: string; sections: ArticleSection[]; headings: Heading[]; html: string;
  text: string; minutes: number; order?: number; markdown?: string;
}
export interface SiteSection { id: SectionId; label: string; title: string; description: string; intro: string; }
export interface Breadcrumb { label: string; route?: string; }
export interface SitePage {
  route: string; title: string; description: string; kind: PageKind;
  section?: SectionId; article?: Article; breadcrumbs?: Breadcrumb[]; noindex?: boolean;
}
export interface ClientDetail { name: string; surface: string; note: string; }
export interface ReportDetail { topic: string; question: string; method: string; boundary: string; }
