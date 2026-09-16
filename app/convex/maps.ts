import { exposeApi } from "@caden/json-cms";

import { components } from "./_generated/api";
import { auth } from "./auth";

export const {
  listMaps: list,
  getMap: get,
  createMap: create,
  updateMap: update,
  deleteMap: remove,
  listMapLayers: listLayers,
  addMapLayer: addLayer,
  removeMapLayer: removeLayer,
  setMapLayerVisibility: setLayerVisibility,
  moveMapLayer: moveLayer,
} = exposeApi(components.jsonCms, { auth });
