# Ghana National Emergency Response & Dispatch Coordination Platform

## System Documentation

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Microservices](#4-microservices)
   - [Identity & Authentication Service](#41-identity--authentication-service)
   - [Emergency Incident Service](#42-emergency-incident-service)
   - [Dispatch Tracking Service](#43-dispatch-tracking-service)
   - [Analytics & Monitoring Service](#44-analytics--monitoring-service)
5. [Database Design](#5-database-design)
6. [Message Queue & Events](#6-message-queue--events)
7. [Real-Time Communication](#7-real-time-communication)
8. [Client Interface](#8-client-interface)
9. [API Reference](#9-api-reference)
10. [Deployment](#10-deployment)
11. [Environment Configuration](#11-environment-configuration)

---

## 1. System Overview

This platform simulates a **national emergency response and dispatch coordination system** for Ghana. It addresses the challenge of independent emergency services (police, fire, hospitals, ambulances) failing to coordinate during emergencies.

### Problem Statement

In Ghana, emergency services operate in silos. When a citizen reports an incident, dispatchers must manually determine which unit is closest, which hospital has beds, and how to track the response — all over phone calls. This platform automates and coordinates that entire workflow.

### What the System Does

1. A **call center administrator** receives an emergency call from a citizen
2. The admin fills an incident report form with citizen details, incident type, and location (via Google Maps)
3. The system **automatically** selects the nearest available responder (police / fire / ambulance)
4. For medical emergencies, the system also assigns the nearest hospital with available beds
5. The assigned responder is **dispatched** and their GPS location is tracked in real-time
6. Dashboards show live vehicle movement on a map
7. Analytics provide operational insights on response times, resource usage, and incident patterns

### System Actors

| Actor | Role |
|-------|------|
| **System Administrator** | Call center operator; receives calls and logs incidents |
| **Hospital Administrator** | Manages hospital capacity and ambulance availability |
| **Police Station Administrator** | Manages police units and officer information |
| **Fire Service Administrator** | Manages fire service trucks and personnel |
| **Ambulance Driver** | Operates ambulance; device transmits GPS location |
| **Citizen** | Reports emergency via phone call; does not log in |

---

## 2. Architecture

### Microservices Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Client (Port 3005)                           │
│              HTML / CSS / Leaflet.js / WebSocket                    │
└────┬──────────────┬──────────────┬───────────────┬──────────────────┘
     │              │              │               │
     ▼              ▼              ▼               ▼
┌─────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐
│  Auth   │  │ Incident │  │ Dispatch │  │  Analytics  │
│ Service │  │ Service  │  │ Service  │  │   Service   │
│  :3001  │  │  :3002   │  │  :3003   │  │    :3004    │
└────┬────┘  └────┬─────┘  └────┬─────┘  └──────┬──────┘
     │            │              │                │
     ▼            ▼              ▼                │
┌─────────┐  ┌─────────┐  ┌──────────┐           │
│Auth_Db  │  │Incident │  │Dispatch  │           │
│(MongoDB)│  │  _Db    │  │   _Db   │           │
│  Atlas  │  │(MongoDB)│  │(MongoDB)│           │
└─────────┘  └────┬────┘  └────┬────┘           │
                  │              │                │
                  ▼              ▼                │
            ┌─────────────────────────┐           │
            │       RabbitMQ          │◄──────────┘
            │  (CloudAMQP / Local)    │    HTTP polling
            │  incident.* events      │
            └─────────────────────────┘
```

### Service Communication

| From | To | Method |
|------|----|--------|
| Client | Auth Service | REST (login, register) |
| Client | Incident Service | REST (CRUD incidents) |
| Client | Dispatch Service | REST + WebSocket (live tracking) |
| Client | Analytics Service | REST (dashboard data) |
| Incident Service | Dispatch Service | RabbitMQ event (`incident.assigned`) |
| Analytics Service | Incident Service | REST HTTP (`/incidents/all`, `/responders`) |
| Analytics Service | Dispatch Service | REST HTTP (`/vehicles`) |

---

## 3. Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | HTML5, Tailwind CSS | UI framework |
| **Maps** | Leaflet.js | Interactive incident & tracking maps |
| **Backend** | Node.js 18, Express.js | REST API server |
| **Database** | MongoDB Atlas | Per-service document storage |
| **Message Queue** | RabbitMQ (CloudAMQP) | Async inter-service events |
| **Real-Time** | WebSocket (`ws` library) | Live vehicle location push |
| **Authentication** | JWT (jsonwebtoken) | Stateless token auth |
| **Password Hashing** | bcryptjs | Secure credential storage |
| **API Docs** | Swagger UI Express | Interactive API documentation |
| **Containerization** | Docker & Docker Compose | Service orchestration |
| **Reverse Proxy** | nginx (Alpine) | Serves client static files |

---

## 4. Microservices

### 4.1 Identity & Authentication Service

**Port:** `3001`
**Database:** `Auth_MongoDb` (MongoDB Atlas)
**Swagger UI:** `http://localhost:3001/api-docs`

#### Responsibility

Manages all platform users. Every request to protected endpoints in other services carries a JWT issued by this service. Citizens do not have accounts.

#### Supported Roles

| Role | Description |
|------|-------------|
| `system_admin` | Call center operators; can create incidents, view all data |
| `hospital_admin` | Hospital staff; manage hospital capacity and beds |
| `police_admin` | Police station admins; manage police units |
| `fire_admin` | Fire service admins; manage fire units |
| `ambulance_driver` | Ambulance operators; transmit GPS location |

#### Collections

**`users`**

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Auto-generated unique ID |
| `name` | String | Full name |
| `email` | String | Unique login email |
| `password_hash` | String | bcrypt hash (10 rounds) |
| `role` | String | One of the 5 roles above |
| `created_at` | Date | Registration timestamp |

#### JWT Token

- **Access token:** 8-hour expiry — contains `id`, `email`, `role`, `name`
- **Refresh token:** 7-day expiry — contains only `id`
- **Algorithm:** HS256

#### Key Files

```
auth-service/
├── Dockerfile
├── package.json
└── src/
    ├── index.js      # All routes and middleware
    ├── db.js         # MongoDB connection
    └── swagger.js    # OpenAPI 3.0 spec
```

---

### 4.2 Emergency Incident Service

**Port:** `3002`
**Database:** `Incident` (MongoDB Atlas)
**Swagger UI:** `http://localhost:3002/api-docs`

#### Responsibility

Core service of the platform. Records incidents, automatically assigns the nearest available responder and hospital, tracks status lifecycle, and publishes events to RabbitMQ.

#### Auto-Assignment Logic

**Step 1 — Determine responder type from incident:**

| Incident Type Keywords | Assigned Responder Type |
|------------------------|------------------------|
| `fire`, `explosion` | `fire` |
| `medical`, `accident`, `injury`, `heart` | `ambulance` |
| Everything else (robbery, crime, etc.) | `police` |

**Step 2 — Find nearest available responder:**

Uses the **Haversine formula** to calculate great-circle distance (km) between the incident coordinates and all available responders of the matching type. Selects the one with the smallest distance.

```
a = sin²(Δlat/2) + cos(lat1) × cos(lat2) × sin²(Δlon/2)
distance = 2R × atan2(√a, √(1−a))     where R = 6371 km
```

**Step 3 — For ambulance incidents, find nearest hospital:**

Queries all hospitals with `available_beds > 0`, applies same Haversine formula, assigns the closest. Decrements `available_beds` by 1.

#### Incident Status Lifecycle

```
CREATED ──► DISPATCHED ──► IN_PROGRESS ──► RESOLVED
                                               │
                          Responder freed ◄────┘
                          Hospital bed released
```

#### Collections

**`incidents`**

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Incident ID |
| `citizen_name` | String | Name of the caller |
| `incident_type` | String | e.g. "Medical Emergency", "Fire" |
| `latitude` | Number | Incident GPS latitude |
| `longitude` | Number | Incident GPS longitude |
| `notes` | String | Additional details from caller |
| `created_by` | ObjectId | Admin who logged the incident |
| `assigned_unit` | ObjectId | Ref to `responders._id` |
| `hospital_id` | ObjectId | Ref to `hospitals._id` (medical only) |
| `status` | String | `created` / `dispatched` / `in_progress` / `resolved` |
| `created_at` | Date | Incident creation time |
| `updated_at` | Date | Last status change time |

**`responders`**

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Responder ID |
| `name` | String | Unit name (e.g. "Accra Central Police") |
| `type` | String | `police` / `fire` / `ambulance` |
| `latitude` | Number | Station/unit GPS latitude |
| `longitude` | Number | Station/unit GPS longitude |
| `is_available` | Boolean | Availability flag |
| `created_at` | Date | Registration time |

**`hospitals`**

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Hospital ID |
| `name` | String | Hospital name |
| `latitude` | Number | Hospital GPS latitude |
| `longitude` | Number | Hospital GPS longitude |
| `capacity` | Integer | Total bed capacity |
| `available_beds` | Integer | Currently available beds |
| `created_at` | Date | Registration time |

#### Key Files

```
incident-service/
├── Dockerfile
├── package.json
└── src/
    ├── index.js      # All routes, Haversine logic, auto-assignment
    ├── db.js         # MongoDB connection (incident_db)
    ├── eventBus.js   # RabbitMQ publish/subscribe with retry
    └── swagger.js    # OpenAPI 3.0 spec
```

---

### 4.3 Dispatch Tracking Service

**Port:** `3003`
**Database:** `Dispatch` (MongoDB Atlas)
**WebSocket:** `ws://localhost:3003`
**Swagger UI:** `http://localhost:3003/api-docs`

#### Responsibility

Maintains real-time GPS positions for every emergency vehicle. Receives location updates from drivers, stores history, and broadcasts live updates to all connected dashboard clients via WebSocket.

#### WebSocket Protocol

Connected clients automatically receive broadcast messages in two scenarios:

**Vehicle dispatched:**
```json
{
  "type": "vehicle_dispatched",
  "vehicle_id": "AMB-001",
  "incident_id": "664f1a2b3c4d5e6f7a8b9c0d"
}
```

**Location update (every GPS ping from a driver):**
```json
{
  "type": "location_update",
  "vehicle": {
    "vehicle_id": "AMB-001",
    "vehicle_name": "Korle-Bu Ambulance 1",
    "latitude": 5.6037,
    "longitude": -0.1870,
    "status": "dispatched",
    "updated_at": "2026-03-18T16:00:00.000Z"
  }
}
```

#### Event Bus Subscription

The service subscribes to `incident.assigned` events from RabbitMQ. When the Incident Service assigns a responder, the Dispatch Service:
1. Updates the vehicle record with the `incident_id`
2. Sets vehicle status to `dispatched`
3. Broadcasts `vehicle_dispatched` to all WebSocket clients

#### Collections

**`vehicle_locations`**

| Field | Type | Description |
|-------|------|-------------|
| `vehicle_id` | String | Unique vehicle identifier (e.g. `AMB-001`) |
| `vehicle_name` | String | Human-readable name |
| `vehicle_type` | String | e.g. `ambulance`, `police`, `fire` |
| `incident_id` | String | Currently assigned incident |
| `latitude` | Number | Current GPS latitude |
| `longitude` | Number | Current GPS longitude |
| `status` | String | `idle` / `dispatched` / `on_scene` / `returning` |
| `updated_at` | Date | Last GPS update time |

**`location_history`**

| Field | Type | Description |
|-------|------|-------------|
| `vehicle_id` | String | Vehicle reference |
| `latitude` | Number | GPS latitude at this point |
| `longitude` | Number | GPS longitude at this point |
| `recorded_at` | Date | Timestamp of this reading |

> History is capped at the **last 50 records** per vehicle query.

#### Key Files

```
dispatch-service/
├── Dockerfile
├── package.json
└── src/
    ├── index.js      # Routes, WebSocket server, GPS broadcast
    ├── db.js         # MongoDB connection (dispatch_db)
    ├── eventBus.js   # RabbitMQ subscription with retry
    └── swagger.js    # OpenAPI 3.0 spec
```

---

### 4.4 Analytics & Monitoring Service

**Port:** `3004`
**Database:** None (aggregates from other services via HTTP)
**Swagger UI:** `http://localhost:3004/api-docs`

#### Responsibility

Produces operational statistics by querying the Incident and Dispatch services. Does not own its own database — all data is fetched on demand and aggregated in memory.

#### Data Flow

```
Analytics Service
    ├── GET {INCIDENT_URL}/incidents/stats/summary  → response times
    ├── GET {INCIDENT_URL}/incidents/all            → incidents by type/status
    ├── GET {INCIDENT_URL}/responders               → resource utilization
    └── GET {DISPATCH_URL}/vehicles                 → vehicle utilization
```

#### Metrics Produced

| Metric | Description |
|--------|-------------|
| `average_response_minutes` | Mean time from incident creation to resolution |
| `total_resolved` | Count of resolved incidents |
| `by_type` | Incident count grouped by incident type |
| `by_status` | Incident count grouped by status |
| `utilization_pct` | Percentage of responders currently deployed |
| `by_type` (resources) | Per-type breakdown of total vs available responders |
| `active_vehicles` | Vehicles not in `idle` status |

#### Key Files

```
analytics-service/
├── Dockerfile
├── package.json
└── src/
    ├── index.js      # All routes with shared data-fetch functions
    └── swagger.js    # OpenAPI 3.0 spec
```

---

## 5. Database Design

All four services connect to the **same MongoDB Atlas cluster** but use **separate databases**, maintaining microservice data isolation.

```
cluster1.xdt50ru.mongodb.net
├── Auth_MongoDb
│   └── users
├── Incident
│   ├── incidents
│   ├── responders
│   └── hospitals
├── Dispatch
│   ├── vehicle_locations
│   └── location_history
└── Analytics
    └── (no collections — data fetched at runtime)
```

### Connection Configuration

Each service's `db.js` uses `MongoClient` with `ServerApiVersion.v1`:

```javascript
client = new MongoClient(uri, {
  serverApi: ServerApiVersion.v1,
  retryWrites: true,
  w: "majority"
});
```

---

## 6. Message Queue & Events

**Broker:** RabbitMQ (CloudAMQP hosted)
**Protocol:** AMQP
**Exchange type:** `topic` (durable)

### Exchanges

| Exchange | Used By |
|----------|---------|
| `incidents` | Incident Service publishes; Dispatch Service subscribes |
| `dispatch` | Reserved for dispatch events |
| `analytics` | Reserved for analytics events |

### Event Definitions

| Event Key | Published By | Subscribed By | Payload |
|-----------|-------------|---------------|---------|
| `incident.created` | Incident Service | — | `{ incident_id, citizen_name, incident_type, latitude, longitude, assigned_unit, hospital_id }` |
| `incident.updated` | Incident Service | — | `{ incident_id, status, assigned_unit }` |
| `incident.assigned` | Incident Service | Dispatch Service | `{ incident_id, responder_id, responder_name }` |

### Message Envelope

All messages are wrapped in a standard envelope:

```json
{
  "eventType": "incident.assigned",
  "timestamp": "2026-03-18T16:00:00.000Z",
  "data": { ... }
}
```

### Connection Retry

Both `incident-service` and `dispatch-service` implement a **retry loop** with 10 attempts and 5-second delay between retries, to handle RabbitMQ startup race conditions in Docker:

```javascript
async function connect(retries = 10, delay = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // connect...
    } catch (error) {
      if (attempt === retries) throw error;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
```

---

## 7. Real-Time Communication

The Dispatch Service runs both an HTTP server and a WebSocket server on the **same port (3003)** using Node's `http.createServer`:

```javascript
const server = http.createServer(app);        // Express HTTP
const wss = new WebSocket.Server({ server }); // WebSocket on same port
```

**Client connection:** `ws://localhost:3003`

All connected clients are stored in a `Set`. When a GPS update arrives or a vehicle is dispatched, the `broadcast()` function iterates the set and sends to all clients with `readyState === OPEN`.

The client frontend connects via:
```javascript
const ws = new WebSocket("ws://localhost:3003");
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === "location_update") { /* update map marker */ }
  if (data.type === "vehicle_dispatched") { /* show dispatch alert */ }
};
```

---

## 8. Client Interface

**Port:** `3005` (served by nginx inside Docker)
**Technology:** Single-page HTML file, Tailwind CSS, Leaflet.js

### Pages / Tabs

| Tab | Accessible By | Features |
|-----|--------------|---------|
| **Login** | All | Email/password authentication |
| **Incidents** | system_admin | Report incidents with map pin, view open incidents, assign responders |
| **Tracking** | All | Live Leaflet map showing all vehicle positions, auto-updates via WebSocket |
| **Hospitals** | hospital_admin, system_admin | Add hospitals, update bed counts |
| **Responders** | All admins | Register police/fire/ambulance units |
| **Analytics** | All | Dashboard with response time, incident breakdown, utilization charts |

### API Endpoints Used by Client

| Service | Base URL |
|---------|---------|
| Auth | `http://localhost:3001` |
| Incidents | `http://localhost:3002` |
| Dispatch | `http://localhost:3003` |
| Analytics | `http://localhost:3004` |
| WebSocket | `ws://localhost:3003` |

### Dockerized Client

```dockerfile
FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

FROM nginx:alpine
COPY --from=build /app /usr/share/nginx/html
EXPOSE 80
```

---

## 9. API Reference

Full interactive documentation is available via Swagger UI when the services are running.

| Service | Swagger UI |
|---------|-----------|
| Auth | `http://localhost:3001/api-docs` |
| Incidents | `http://localhost:3002/api-docs` |
| Dispatch | `http://localhost:3003/api-docs` |
| Analytics | `http://localhost:3004/api-docs` |

### Auth Service Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/register` | None | Register a new user |
| POST | `/auth/login` | None | Login, receive JWT + refresh token |
| POST | `/auth/refresh-token` | None | Exchange refresh token for new access token |
| GET | `/auth/profile` | Bearer | Get current user profile |
| GET | `/auth/verify` | Bearer | Verify token validity (used by other services) |
| GET | `/auth/users` | Bearer (system_admin) | List all users |

### Incident Service Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/incidents` | Bearer | Create incident + auto-assign responder |
| GET | `/incidents/open` | Bearer | Get all non-resolved incidents |
| GET | `/incidents/all` | Bearer | Get all incidents |
| GET | `/incidents/stats/summary` | None | Aggregated stats for Analytics Service |
| GET | `/incidents/:id` | Bearer | Get single incident |
| PUT | `/incidents/:id/status` | Bearer | Update status (resolving frees responder) |
| PUT | `/incidents/:id/assign` | Bearer | Manually assign a responder |
| GET | `/responders` | Bearer | List all responder units |
| POST | `/responders` | Bearer | Register new responder unit |
| GET | `/hospitals` | Bearer | List all hospitals |
| POST | `/hospitals` | Bearer | Register new hospital |
| PUT | `/hospitals/:id` | Bearer | Update hospital / bed count |

### Dispatch Service Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/vehicles/register` | Bearer | Register or update a vehicle |
| POST | `/vehicles/assign` | None | Assign vehicle to incident (internal) |
| GET | `/vehicles` | Bearer | List all vehicles with current location |
| GET | `/vehicles/:id/location` | Bearer | Get current location of a vehicle |
| PUT | `/vehicles/:id/location` | Bearer | Push GPS update (triggers WebSocket broadcast) |
| GET | `/vehicles/:id/history` | Bearer | Get last 50 GPS records |

### Analytics Service Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/analytics/response-times` | Bearer | Average response time + total resolved |
| GET | `/analytics/incidents-by-region` | Bearer | Incidents grouped by type and status |
| GET | `/analytics/resource-utilization` | Bearer | Responder and vehicle utilization % |
| GET | `/analytics/dashboard` | Bearer | All three analytics in one request |

---

## 10. Deployment

### Prerequisites

- Docker Desktop installed and running
- A MongoDB Atlas cluster (free tier works)
- A RabbitMQ broker (CloudAMQP free tier, or local via Docker)

### Project Structure

```
emergency-platform/
├── .env                    # Environment variables (never commit to git)
├── docker-compose.yml      # Orchestrates all services
├── auth-service/
├── incident-service/
├── dispatch-service/
├── analytics-service/
└── client/
```

### Starting the Platform

```bash
# First run — build all images
docker-compose up --build

# Subsequent runs
docker-compose up

# Force clean rebuild (if package.json changed)
docker-compose down
docker-compose build --no-cache
docker-compose up

# Stop everything
docker-compose down
```

### Service URLs After Startup

| Service | URL |
|---------|-----|
| Client UI | `http://localhost:3005` |
| Auth Service | `http://localhost:3001` |
| Incident Service | `http://localhost:3002` |
| Dispatch Service | `http://localhost:3003` |
| Analytics Service | `http://localhost:3004` |
| RabbitMQ Management | `http://localhost:15672` (guest / guest) |

### Docker Compose Overview

```yaml
services:
  rabbitmq:          # Message broker with healthcheck
  redis:             # Available for future caching
  auth-service:      # Depends on rabbitmq
  incident-service:  # Depends on rabbitmq (healthy)
  dispatch-service:  # Depends on rabbitmq (healthy)
  analytics-service: # Depends on incident + dispatch services
  client:            # Depends on all services
```

---

## 11. Environment Configuration

### `.env` File

```env
JWT_SECRET=<your-jwt-secret>
RABBITMQ_URL=amqps://<user>:<pass>@<host>/<vhost>

# MongoDB Atlas — same cluster, different databases
AUTH_MONGODB_URL=mongodb+srv://<user>:<pass>@<cluster>/Auth_MongoDb?retryWrites=true&w=majority
INCIDENT_MONGODB_URL=mongodb+srv://<user>:<pass>@<cluster>/Incident?retryWrites=true&w=majority
DISPATCH_MONGODB_URL=mongodb+srv://<user>:<pass>@<cluster>/Dispatch?retryWrites=true&w=majority
ANALYTICS_MONGODB_URL=mongodb+srv://<user>:<pass>@<cluster>/Analytics?retryWrites=true&w=majority
```

> **Note:** Special characters in passwords must be URL-encoded:
> `@` → `%40`, `<` → `%3C`, `>` → `%3E`, `#` → `%23`

### Environment Variables Per Service

| Variable | Used By | Description |
|----------|---------|-------------|
| `JWT_SECRET` | All services | Signs and verifies JWT tokens |
| `MONGODB_URL` | auth, incident, dispatch | MongoDB Atlas connection string |
| `RABBITMQ_URL` | incident, dispatch | RabbitMQ broker connection string |
| `INCIDENT_SERVICE_URL` | analytics | Internal URL to incident service |
| `DISPATCH_SERVICE_URL` | analytics | Internal URL to dispatch service |
| `PORT` | All services | HTTP listening port |

### MongoDB Atlas Setup

1. Create a free cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas)
2. Create a database user under **Database Access**
3. Whitelist `0.0.0.0/0` under **Network Access** (for Docker)
4. Copy the connection string and set it in `.env` for each service with the correct database name

### RabbitMQ Setup (CloudAMQP)

1. Create a free instance at [cloudamqp.com](https://www.cloudamqp.com)
2. Copy the `AMQP URL` from the instance details
3. Set it as `RABBITMQ_URL` in `.env`

---

*Documentation generated for CPEN 421 — Distributed Software Systems Course Project*
