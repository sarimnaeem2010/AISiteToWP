import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectsRouter from "./projects";
import adminRouter from "./admin";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(adminRouter);
router.use(projectsRouter);

export default router;
