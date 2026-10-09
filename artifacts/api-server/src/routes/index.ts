import { Router, type IRouter } from "express";
import healthRouter from "./health";
import lanesightRouter from "./lanesight";

const router: IRouter = Router();

router.use(healthRouter);
router.use(lanesightRouter);

export default router;
