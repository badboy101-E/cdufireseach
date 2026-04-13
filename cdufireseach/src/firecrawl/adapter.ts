import type {
  CatalogSite,
  DepartmentProfile,
  DepartmentSiteSearchResult,
  DepartmentsResult,
  OrganizationStructure,
  SiteAnswerResult,
  SiteCatalogResult,
  SiteContentResult,
  SiteSearchResult
} from "../types.js";

export interface FirecrawlAdapter {
  getOrgStructure(): Promise<OrganizationStructure>;
  getDepartments(): Promise<DepartmentsResult>;
  getSiteCatalog(): Promise<SiteCatalogResult>;
  findSite(keyword: string): Promise<SiteSearchResult>;
  getSiteContent(siteName: string): Promise<SiteContentResult>;
  askSite(question: string, siteName?: string): Promise<SiteAnswerResult>;
  findDepartmentSite(keyword: string): Promise<DepartmentSiteSearchResult>;
  getDepartmentProfile(departmentName: string): Promise<DepartmentProfile>;
}
