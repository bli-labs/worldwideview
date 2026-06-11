/**
 * Merge installed-plugin DB records with local sandbox plugins from
 * /public/plugins-local.
 *
 * Local plugins shadow installed records with the same pluginId — that is
 * the point of the sandbox: a first-party or in-development bundle must win
 * over whatever published version a fresh-install seed pinned in the DB.
 * Without this, the client registers the (older) DB manifest first and the
 * local bundle is silently ignored.
 */
export interface PluginConfigRecord {
  pluginId: string;
  config: string;
}

export function mergeInstalledWithLocal<T extends PluginConfigRecord>(
  records: T[],
  localPlugins: PluginConfigRecord[],
): PluginConfigRecord[] {
  const localIds = new Set(localPlugins.map((p) => p.pluginId));
  return [
    ...records.filter((r) => !localIds.has(r.pluginId)),
    ...localPlugins,
  ];
}
