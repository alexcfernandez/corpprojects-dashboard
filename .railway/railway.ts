import { defineRailway, github, project, service } from "railway/iac";
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
  });

  return project("corpprojects-dashboard", {
    variables: { managed: false },
    resources: [corpprojectsDashboard],
  });
});
