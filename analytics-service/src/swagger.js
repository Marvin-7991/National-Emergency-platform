const swaggerDocument = {
  openapi: "3.0.0",
  info: {
    title: "Analytics & Monitoring Service",
    version: "1.0.0",
    description: "Aggregates data from the Incident and Dispatch services to produce operational insights and statistics for the Ghana Emergency Response Platform."
  },
  servers: [{ url: "http://localhost:3004", description: "Local" }],
  components: {
    securitySchemes: {
      BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
    },
    schemas: {
      ResponseTimes: {
        type: "object",
        properties: {
          average_response_minutes: { type: "string", example: "12.4" },
          total_resolved:           { type: "integer", example: 38 }
        }
      },
      IncidentsByRegion: {
        type: "object",
        properties: {
          total:     { type: "integer", example: 54 },
          by_type:   { type: "object", additionalProperties: { type: "integer" }, example: { "Medical Emergency": 20, "Fire": 10, "Robbery": 24 } },
          by_status: { type: "object", additionalProperties: { type: "integer" }, example: { "resolved": 38, "dispatched": 10, "in_progress": 6 } }
        }
      },
      ResourceUtilization: {
        type: "object",
        properties: {
          total_responders:  { type: "integer", example: 15 },
          available:         { type: "integer", example: 9 },
          deployed:          { type: "integer", example: 6 },
          utilization_pct:   { type: "string", example: "40.0" },
          by_type: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                total:     { type: "integer" },
                available: { type: "integer" }
              }
            },
            example: { "ambulance": { "total": 5, "available": 3 }, "police": { "total": 7, "available": 4 } }
          },
          active_vehicles: { type: "integer", example: 6 },
          total_vehicles:  { type: "integer", example: 15 }
        }
      },
      Dashboard: {
        type: "object",
        properties: {
          response_times: { $ref: "#/components/schemas/ResponseTimes" },
          incidents:      { $ref: "#/components/schemas/IncidentsByRegion" },
          resources:      { $ref: "#/components/schemas/ResourceUtilization" }
        }
      },
      Error: {
        type: "object",
        properties: { error: { type: "string" } }
      }
    }
  },
  paths: {
    "/analytics/response-times": {
      get: {
        tags: ["Analytics"],
        summary: "Average response time and total resolved incidents",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "Response time statistics", content: { "application/json": { schema: { $ref: "#/components/schemas/ResponseTimes" } } } },
          401: { description: "Unauthorized" },
          500: { description: "Upstream service error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },
    "/analytics/incidents-by-region": {
      get: {
        tags: ["Analytics"],
        summary: "Incident counts grouped by type and status",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "Incidents breakdown", content: { "application/json": { schema: { $ref: "#/components/schemas/IncidentsByRegion" } } } },
          401: { description: "Unauthorized" }
        }
      }
    },
    "/analytics/resource-utilization": {
      get: {
        tags: ["Analytics"],
        summary: "Responder and vehicle utilization statistics",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "Resource utilization", content: { "application/json": { schema: { $ref: "#/components/schemas/ResourceUtilization" } } } },
          401: { description: "Unauthorized" }
        }
      }
    },
    "/analytics/dashboard": {
      get: {
        tags: ["Analytics"],
        summary: "Combined dashboard — all analytics in one request",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "Full dashboard data", content: { "application/json": { schema: { $ref: "#/components/schemas/Dashboard" } } } },
          401: { description: "Unauthorized" }
        }
      }
    }
  }
};

module.exports = swaggerDocument;
