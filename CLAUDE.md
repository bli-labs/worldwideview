AGENTS.md

## WorldWideView MCP Access

You have access to the WorldWideView (WWV) geospatial intelligence engine via MCP.
WWV visualizes real-time global data on an interactive 3D CesiumJS globe, including aviation,
incidents, weather, and custom data plugins.

This MCP connection is live and authenticated. You can call these tools:

Data query:
- search_entities: search entities by name across active plugins; supports optional inline filters.
- get_entities_in_region: find entities inside a lat/lng bounding box.
- get_entity_details: get full details for one entity by pluginId + entityId.
- get_plugin_data: get the current snapshot of all entities for a plugin.

Location (geocoding + camera):
- geocode_location: resolve a place name or address to coordinates and a bounding box.
- fly_to: fly the live globe camera to a coordinate or bounding box.

Favorites:
- save_favorite: bookmark an entity so the user can return to it later.
- list_favorites: list the user's bookmarks, each with a live/stale status.
- remove_favorite: delete a bookmarked entity.

Live filtering:
- get_plugin_filters: list the filterable fields a plugin declares.
- set_filter: apply filters to a plugin's layer on the live globe.
- clear_filter: clear one plugin's filters, or all filters.

When the user asks about global data, geospatial queries, or globe visualisation, use these tools
to find places, move the camera, search and filter live entities, and manage their bookmarks.

Note: fly_to, set_filter, and clear_filter control the live globe and only take visible effect while you have a signed-in WorldWideView browser tab open. The read and query tools work with just your API key.
