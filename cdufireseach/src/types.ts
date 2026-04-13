export type LinkItem = {
  name: string;
  url: string;
};

export type CatalogSite = {
  name: string;
  category: string;
  website_url: string;
  source_url: string;
  source_kind: "organization" | "department";
  group_name?: string;
  last_synced_at: string;
};

export type OrganizationGroup = {
  group_name: string;
  items: LinkItem[];
};

export type OrganizationStructure = {
  source_url: string;
  fetched_at: string;
  groups: OrganizationGroup[];
};

export type DepartmentSite = {
  name: string;
  category: string;
  website_url: string;
  source_url: string;
  last_synced_at: string;
};

export type DepartmentsResult = {
  source_url: string;
  fetched_at: string;
  departments: DepartmentSite[];
};

export type DepartmentSiteSearchResult = {
  keyword: string;
  matches: DepartmentSite[];
};

export type SiteCatalogResult = {
  fetched_at: string;
  sites: CatalogSite[];
};

export type SiteSearchResult = {
  keyword: string;
  matches: CatalogSite[];
};

export type SiteContentResult = {
  site_name: string;
  website_url: string;
  title: string;
  summary: string;
  important_links: LinkItem[];
  markdown_excerpt: string;
  source_url: string;
  fetched_at: string;
};

export type SiteAnswerResult = {
  question: string;
  answered: boolean;
  answer: string;
  evidence: string;
  analysis_steps: string[];
  matched_site: CatalogSite | null;
  source_urls: string[];
  fetched_at: string;
};

export type DepartmentProfile = {
  department_name: string;
  website_url: string;
  title: string;
  summary: string;
  important_links: LinkItem[];
  source_url: string;
  fetched_at: string;
};
