import { MovementMap } from "./movement-map";
import { RouteMap as OriginalRouteMap } from "./route-map";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof OriginalRouteMap>;

/**
 * Temporary Map-tab experiment. Weather preview cards still use the original
 * route map; the main Map tab gets adaptive departure-ground / airborne /
 * arrival-ground behavior.
 */
export function RouteMap(props: Props) {
  if (props.weatherPreview || !props.fixedViewport) return <OriginalRouteMap {...props} />;
  return <MovementMap story={props.story} />;
}
