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
import type { MemoryMatchResult } from "../memory/markdownMemory.js";

export interface FirecrawlAdapter {
  getOrgStructure(): Promise<OrganizationStructure>;
  getDepartments(): Promise<DepartmentsResult>;
  getSiteCatalog(): Promise<SiteCatalogResult>;
  findSite(keyword: string): Promise<SiteSearchResult>;
  getSiteContent(siteName: string): Promise<SiteContentResult>;
  getMemoryCandidates(question: string, siteName?: string): Promise<MemoryMatchResult[]>;
  askSite(
    question: string,
    siteName?: string,
    options?: {
      skipMemory?: boolean;
    }
  ): Promise<SiteAnswerResult>;
  findDepartmentSite(keyword: string): Promise<DepartmentSiteSearchResult>;
  getDepartmentProfile(departmentName: string): Promise<DepartmentProfile>;
}
