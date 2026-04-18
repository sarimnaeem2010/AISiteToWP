import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectsRouter from "./projects";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(adminRouter);
router.use(projectsRouter);

export default router;
