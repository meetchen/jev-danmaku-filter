/** 注册表本身不含任何站点知识，可以被单元测试直接实例化。 */
export function createRegistry(sites) {
  return {
    sites,
    find(href) {
      for (const site of sites) {
        try {
          if (site.matches(href)) return site;
        } catch { /* 单个站点匹配抛错不能拖垮整条链路 */ }
      }
      return null;
    },
  };
}
