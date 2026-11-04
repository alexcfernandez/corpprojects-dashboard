import { defineRailway, github, project, service, volume } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "corpprojects-dashboard";
export default defineRailway(() => {
  const corpprojectsDashboard = service("corpprojects-dashboard", {
    source: github("alexcfernandez/corpprojects-dashboard", { branch: "main", checkSuites: false }),
    build: { buildEnvironment: "V3", builder: "RAILPACK" },
    start: "npm start",
    healthcheck: "/health",
    healthcheckTimeout: 30,
    deploy: { restartPolicyMaxRetries: 3 },
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["dashboard.corpprojects.es"],
    // Fotos y PDF (compras, nóminas, vehículos, grupos): fuera de Mongo, ver src/almacen.js.
    volumeMounts: { "/data": volume("corp-archivos", { sizeMB: 5000 }) },
  });

  return project("corpprojects-dashboard", {
    variables: { managed: false },
    resources: [corpprojectsDashboard],
  });
});
