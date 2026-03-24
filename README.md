# Ghana Emergency Response Platform

A real-time national emergency response and dispatch system built with a microservices architecture. Designed for CPEN 421 — Mobile and Web Software Design and Architecture.

---

## Overview

This platform enables emergency coordinators across Ghana to report incidents, dispatch the nearest available responder unit, and track the responding vehicle live on a map until the incident is resolved.

**Key capabilities:**
- Report incidents from anywhere in Ghana using an interactive map
- System automatically finds and assigns the nearest available responder
- Live tracking map shows all registered vehicles; the dispatched vehicle moves visibly toward the incident
- Status auto-transitions: `Dispatched → En Route → Resolved` based on real travel time
- Analytics dashboard with response times, incident breakdown, and resource utilisation
- Ghana-wide coverage — 126 responders and 65 vehicles seeded across all 16 regions

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Client (Nginx)                    │  :3005
│         Single-page app — Leaflet.js maps           │
└────────┬──────────┬──────────┬────────┬─────────────┘
         │          │          │        │
    :3001│     :3002│     :3003│   :3004│
┌────────▼─┐ ┌──────▼──┐ ┌────▼────┐ ┌─▼──────────┐
│  Auth    │ │Incident │ │Dispatch │ │ Analytics  │
│ Service  │ │ Service │ │ Service │ │  Service   │
└──────────┘ └────┬────┘ └────┬────┘ └────────────┘
                  │  RabbitMQ │
            ┌─────▼───────────▼─────┐
            │   MongoDB Atlas (x3)  │
            │  Auth / Incident /    │
            │  Dispatch databases   │
            └───────────────────────┘
```

| Service | Port | Responsibility |
|---|---|---|
| Auth Service | 3001 | JWT authentication, user registration & login |
| Incident Service | 3002 | Incident CRUD, responder assignment, hospital matching |
| Dispatch Service | 3003 | Vehicle registry, GPS location updates, WebSocket live feed |
| Analytics Service | 3004 | Response time stats, incident summaries, resource utilisation |
| Client | 3005 | Frontend SPA served by Nginx |

---

## Tech Stack

**Backend**
- Node.js + Express
- MongoDB Atlas (separate database per service)
- RabbitMQ (CloudAMQP) — event bus between services
- JSON Web Tokens (JWT) — 8-hour access tokens, 7-day refresh tokens
- WebSocket — real-time vehicle location broadcast

**Frontend**
- Vanilla JS + Tailwind CSS
- Leaflet.js — interactive maps (incident reporting, live tracking, location picker)
- Nominatim / OpenStreetMap — address search and reverse geocoding

**Infrastructure**
- Docker + Docker Compose — all services containerised

---

## Features

### Incident Reporting
- Full-screen map with address search, GPS, and click-to-pin
- Incident types: Medical Emergency, Fire Outbreak, Road Accident, Robbery, Flood, Explosion
- System finds the nearest available responder using the Haversine formula
- Nearest matching vehicle is automatically linked and dispatched

### Live Vehicle Tracking
- All registered vehicles shown on map at their current locations
- Dispatched vehicle highlighted with a pulsing ring; moves smoothly toward the incident
- Animated route line (flowing dashes) from vehicle to incident
- Active Dispatch Panel: live ETA countdown, progress bar, status timeline
- Vehicle sidebar shows: Available / Dispatched / En Route / On Scene badges
- On arrival: green "Resolved" banner, incident marker turns to ✅

### Status Flow
```
Created → Dispatched → In Progress → Resolved
```
- `Dispatched` — responder assigned, vehicle leaving station
- `In Progress` — vehicle confirmed moving (2% into journey)
- `Resolved` — vehicle arrives at incident location

### Management
- Register hospitals, responders, and vehicles
- Interactive map picker for setting locations (supports all 16 Ghana regions)
- Region quick-jump buttons for adding units to under-served areas
- Roles: System Admin, Hospital Admin, Police Admin, Fire Admin, Ambulance Driver

### Analytics
- Average response time
- Incidents by type and status
- Responder availability breakdown
- Deployment rate and active vehicle count

---

## Getting Started

### Prerequisites
- Docker Desktop
- A `.env` file in the project root (see below)

### Environment Variables

Create a `.env` file in the project root:

```env
AUTH_MONGODB_URL=mongodb+srv://<user>:<pass>@cluster.mongodb.net/Auth_MongoDb
INCIDENT_MONGODB_URL=mongodb+srv://<user>:<pass>@cluster.mongodb.net/incident_db
DISPATCH_MONGODB_URL=mongodb+srv://<user>:<pass>@cluster.mongodb.net/Dispatch
JWT_SECRET=your_jwt_secret_here
RABBITMQ_URL=amqps://user:pass@your-cloudamqp-host/vhost
```

### Run

```bash
docker compose up --build
```

Then open **http://localhost:3005** in your browser.

### Demo Credentials

| Role | Email | Password |
|---|---|---|
| System Admin | admin@emergency.gh | admin123 |
| Hospital Admin | hospital@emergency.gh | admin123 |
| Police Admin | police@emergency.gh | admin123 |
| Fire Admin | fire@emergency.gh | admin123 |
| Ambulance Driver | driver@emergency.gh | admin123 |

---

## Project Structure

```
emergency-platform/
├── auth-service/          # Authentication & user management
├── incident-service/      # Incident lifecycle & responder assignment
├── dispatch-service/      # Vehicle tracking & WebSocket
├── analytics-service/     # Aggregated stats
├── client/
│   ├── index.html         # Single-page frontend
│   └── Dockerfile         # Nginx serving
└── docker-compose.yml
```

---

## Course

**CPEN 421** — Mobile and Web Software Design and Architecture
University of Ghana, School of Engineering Sciences
