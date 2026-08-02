import apiKeys from "@vllnt/convex-api-keys/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(apiKeys);

export default app;
