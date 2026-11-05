import { Router, type IRouter } from "express";
import {
  GetBikeNetworkResponse,
  GetBikeStationsResponse,
  GetStreetConditionsResponse,
  PlanBikeRouteBody,
  PlanBikeRouteResponse,
  type ApiError,
} from "@workspace/api-zod";
import {
  getBikeNetwork,
  getBikeStations,
  getStreetConditions,
} from "../lib/lanesight-service";
import {
  BikeRoutingUnavailableError,
  PlaceNotFoundError,
  planBikeRoute,
} from "../lib/lanesight-routing";

const router: IRouter = Router();

function errorResponse(error: string): ApiError {
  return { error };
}

router.get("/lanesight/bikeways", async (req, res): Promise<void> => {
  try {
    const data = GetBikeNetworkResponse.parse(await getBikeNetwork());
    res.json(data);
  } catch (error) {
    req.log.error({ err: error }, "Unable to load the SFMTA bikeway network");
    res
      .status(502)
      .json(errorResponse("The San Francisco bikeway map is temporarily unavailable."));
  }
});

router.get("/lanesight/stations", async (req, res): Promise<void> => {
  try {
    const data = GetBikeStationsResponse.parse(await getBikeStations());
    res.json(data);
  } catch (error) {
    req.log.error({ err: error }, "Unable to load live Bay Wheels station status");
    res
      .status(502)
      .json(errorResponse("Live Bay Wheels availability is temporarily unavailable."));
  }
});

router.get("/lanesight/conditions", async (req, res): Promise<void> => {
  try {
    const data = GetStreetConditionsResponse.parse(await getStreetConditions());
    res.json(data);
  } catch (error) {
    req.log.error({ err: error }, "Unable to load San Francisco street conditions");
    res
      .status(502)
      .json(errorResponse("San Francisco street condition data is temporarily unavailable."));
  }
});

router.post("/lanesight/route", async (req, res): Promise<void> => {
  const parsed = PlanBikeRouteBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ issueCount: parsed.error.issues.length }, "Rejected invalid route request");
    res.status(400).json(errorResponse("Enter both a starting point and a destination."));
    return;
  }

  try {
    const result = PlanBikeRouteResponse.parse(
      await planBikeRoute(parsed.data.origin, parsed.data.destination),
    );
    res.json(result);
  } catch (error) {
    if (error instanceof PlaceNotFoundError) {
      res.status(404).json(errorResponse(error.message));
      return;
    }
    if (error instanceof BikeRoutingUnavailableError) {
      res.status(502).json(errorResponse(error.message));
      return;
    }

    req.log.error({ err: error }, "Unable to calculate a bicycle route");
    res
      .status(502)
      .json(errorResponse("Route planning is temporarily unavailable. Please try again."));
  }
});

export default router;
