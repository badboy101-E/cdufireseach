import type {
  CatalogSite,
  DepartmentSite,
  DepartmentsResult,
  LinkItem,
  OrganizationGroup,
  OrganizationStructure,
  SiteCatalogResult,
  SiteSearchResult
} from "../types.js";

type ScrapeResponse = {
  data?: {
    json?: Record<string, unknown>;
    markdown?: string;
  };
};

type BuildOrgStructureInput = {
  orgUrl: string;
  scrape: () => Promise<ScrapeResponse>;
  parseGroupsFromJson: (payload: Record<string, unknown> | undefined) => OrganizationGroup[];
  parseGroupsFromMarkdown: (markdown: string) => OrganizationGroup[];
  fetchOrgHtml: () => Promise<string>;
  parseGroupsFromHtml: (html: string) => OrganizationGroup[];
  nowIso: () => string;
};

type BuildDepartmentsInput = {
  deptUrl: string;
  scrapeJson: () => Promise<ScrapeResponse>;
  scrapeMarkdown: () => Promise<ScrapeResponse>;
  parseDepartmentsFromJson: (payload: Record<string, unknown> | undefined) => DepartmentSite[];
  parseDepartmentsFromMarkdown: (markdown: string) => DepartmentSite[];
  nowIso: () => string;
};

type BuildSiteCatalogInput = {
  orgUrl: string;
  deptUrl: string;
  org: OrganizationStructure;
  departments: DepartmentsResult;
  toCatalogSite: (
    item: DepartmentSite,
    sourceKind: "organization" | "department",
    groupName?: string
  ) => CatalogSite;
  fetchOrgHtml: () => Promise<string>;
  parseSupplementalOrgLinksFromHtml: (html: string) => LinkItem[];
  dedupeCatalogSites: (items: CatalogSite[]) => CatalogSite[];
  urlLooksSuspicious: (url: string) => boolean;
  nowIso: () => string;
};

export class CduCatalogService {
  async buildOrgStructure(input: BuildOrgStructureInput): Promise<OrganizationStructure> {
    const response = await input.scrape();
    const groups = input.parseGroupsFromJson(response.data?.json);
    if (groups.length > 0) {
      return {
        source_url: input.orgUrl,
        fetched_at: input.nowIso(),
        groups
      };
    }

    const markdown = response.data?.markdown;
    const markdownGroups = markdown ? input.parseGroupsFromMarkdown(markdown) : [];
    if (markdownGroups.length > 0) {
      return {
        source_url: input.orgUrl,
        fetched_at: input.nowIso(),
        groups: markdownGroups
      };
    }

    const html = await input.fetchOrgHtml();
    const htmlGroups = input.parseGroupsFromHtml(html);
    if (htmlGroups.length === 0) {
      throw new Error("Organization extraction returned no groups");
    }

    return {
      source_url: input.orgUrl,
      fetched_at: input.nowIso(),
      groups: htmlGroups
    };
  }

  async buildDepartments(input: BuildDepartmentsInput): Promise<DepartmentsResult> {
    const response = await input.scrapeJson();
    let departments = input.parseDepartmentsFromJson(response.data?.json);

    if (departments.length === 0) {
      const markdownFallback = await input.scrapeMarkdown();
      const markdown = markdownFallback.data?.markdown ?? response.data?.markdown;
      if (!markdown) {
        throw new Error("Department extraction returned no markdown");
      }
      departments = input.parseDepartmentsFromMarkdown(markdown);
    }

    return {
      source_url: input.deptUrl,
      fetched_at: input.nowIso(),
      departments
    };
  }

  async buildSiteCatalog(input: BuildSiteCatalogInput): Promise<SiteCatalogResult> {
    const orgSites: CatalogSite[] = input.org.groups.flatMap((group) =>
      group.items
        .filter((item) => item.url.startsWith("http"))
        .map((item) =>
          input.toCatalogSite(
            {
              name: item.name,
              category: group.group_name,
              website_url: item.url,
              source_url: input.org.source_url,
              last_synced_at: input.org.fetched_at
            },
            "organization",
            group.group_name
          )
        )
    );

    const departmentSites = input.departments.departments.map((item) =>
      input.toCatalogSite(item, "department")
    );

    let supplementalOrgSites: CatalogSite[] = [];
    try {
      const html = await input.fetchOrgHtml();
      supplementalOrgSites = input.parseSupplementalOrgLinksFromHtml(html).map((item) =>
        input.toCatalogSite(
          {
            name: item.name,
            category: "组织机构",
            website_url: item.url,
            source_url: input.orgUrl,
            last_synced_at: input.nowIso()
          },
          "organization",
          "组织机构"
        )
      );
    } catch {
      supplementalOrgSites = [];
    }

    return {
      fetched_at: input.nowIso(),
      sites: input.dedupeCatalogSites(
        [...orgSites, ...supplementalOrgSites, ...departmentSites].filter(
          (item) =>
            item.website_url !== item.source_url &&
            item.website_url !== input.orgUrl &&
            item.website_url !== input.deptUrl &&
            !input.urlLooksSuspicious(item.website_url)
        )
      )
    };
  }

  findSite(
    catalog: SiteCatalogResult,
    keyword: string,
    scoreSite: (site: CatalogSite, keyword: string) => number
  ): SiteSearchResult {
    const matches = catalog.sites
      .map((item) => ({
        item,
        score: scoreSite(item, keyword)
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.item)
      .slice(0, 10);

    return {
      keyword,
      matches
    };
  }
}
