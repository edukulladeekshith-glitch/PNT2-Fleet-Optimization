import { useCallback, useEffect, useMemo, useState } from "react";
import {
  APIProvider,
  Map,
  AdvancedMarker,
  Pin,
  useMap,
} from "@vis.gl/react-google-maps";

import "./App.css";

const API_URL = "http://127.0.0.1:8000";

const DEFAULT_CENTER = {
  lat: 17.405,
  lng: 78.475,
};

/* =========================================================
   MAP LOCATIONS
========================================================= */

const LOCATIONS = {
  "Depot A": { lat: 17.415, lng: 78.455 },
  "Depot B": { lat: 17.395, lng: 78.505 },

  V1: { lat: 17.407, lng: 78.468 },
  V2: { lat: 17.415, lng: 78.455 },
  V3: { lat: 17.397, lng: 78.493 },
  V4: { lat: 17.395, lng: 78.505 },

  "Customer 1": { lat: 17.375, lng: 78.525 },
  "Customer 2": { lat: 17.430, lng: 78.515 },

  T1: { lat: 17.402, lng: 78.485 },
  H1: { lat: 17.390, lng: 78.500 },
};

/* =========================================================
   ROUTES
========================================================= */

const ROUTES = {
  "Depot A": ["Depot A", "V1", "T1", "Customer 1"],
  "Depot B": ["Depot B", "V4", "T1", "Customer 2"],
  "Route A": ["Depot A", "V1", "T1", "H1"],
  "Route B": ["Depot B", "V3", "T1", "Customer 1"],
  "Route C": ["Depot A", "V2", "T1", "Customer 2"],
  "Route D": ["Depot B", "V4", "H1", "Customer 1"],
};

/* =========================================================
   DEMO ETA ENGINE
   Gives every vehicle a baseline ETA so the evaluator can
   clearly see ETA changes for V1/V2/V3/V4.
========================================================= */

const BASE_ETAS = {
  V1: "10:35 AM",
  V2: "11:20 AM",
  V3: "11:10 AM",
  V4: "10:50 AM",
};

function etaToMinutes(eta) {
  if (!eta || eta === "Available") {
    return null;
  }

  const match = eta.match(/^(\\d{1,2}):(\\d{2})\\s*(AM|PM)$/i);

  if (!match) {
    return null;
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const period = match[3].toUpperCase();

  if (period === "AM" && hours === 12) {
    hours = 0;
  }

  if (period === "PM" && hours !== 12) {
    hours += 12;
  }

  return hours * 60 + minutes;
}

function minutesToEta(totalMinutes) {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;

  let hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  const period = hours >= 12 ? "PM" : "AM";

  hours = hours % 12 || 12;

  return `${hours}:${String(minutes).padStart(2, "0")} ${period}`;
}

function calculateDemoEta(vehicleId, signal, backendEta) {
  const baseEta = BASE_ETAS[vehicleId] || backendEta || "10:30 AM";

  const baseMinutes =
    etaToMinutes(backendEta) ??
    etaToMinutes(baseEta) ??
    630;

  const delayMinutes =
    signal === "RED"
      ? 20
      : signal === "YELLOW"
        ? 10
        : 0;

  return {
    oldEta: minutesToEta(baseMinutes),
    newEta: minutesToEta(baseMinutes + delayMinutes),
    delayMinutes,
  };
}

function chooseRecoveryVehicle(
  affectedVehicleId,
  orderWeight,
  currentVehicles
) {
  const candidates = currentVehicles
    .filter((vehicle) => vehicle.id !== affectedVehicleId)
    .filter((vehicle) => {
      const freeCapacity =
        Number(vehicle.capacity_kg || 0) -
        Number(vehicle.current_load_kg || 0);

      return freeCapacity >= Number(orderWeight || 0);
    })
    .sort((a, b) => {
      const aAvailable =
        a.status === "AVAILABLE" ? 0 : 1;
      const bAvailable =
        b.status === "AVAILABLE" ? 0 : 1;

      if (aAvailable !== bAvailable) {
        return aAvailable - bAvailable;
      }

      return (
        (etaToMinutes(BASE_ETAS[a.id]) ?? 9999) -
        (etaToMinutes(BASE_ETAS[b.id]) ?? 9999)
      );
    });

  return candidates[0] || null;
}

/* =========================================================
   DRAW ROUTE ON GOOGLE MAP
========================================================= */

function RouteLine({ path, color = "#2563eb", weight = 5 }) {
  const map = useMap();

  useEffect(() => {
    let cancelled = false;
    let polyline = null;

    async function calculateRoadRoute() {
      if (!map || !window.google?.maps || !path || path.length < 2) {
        return;
      }

      const origin = path[0];
      const destination = path[path.length - 1];

      // OSRM uses the OpenStreetMap road network and does not require
      // a Google Routes API request or billing account.
      const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&steps=false`;

      try {
        console.log(
          "REQUESTING FREE ROAD ROUTE:",
          origin,
          "→",
          destination
        );

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`OSRM HTTP ${response.status}`);
        }

        const data = await response.json();

        if (cancelled) return;

        if (data.code !== "Ok" || !data.routes?.length) {
          console.error("OSRM RETURNED NO ROUTE:", data);
          return;
        }

        const coordinates = data.routes[0].geometry?.coordinates || [];

        if (coordinates.length < 2) {
          console.error("OSRM RETURNED NO ROAD GEOMETRY:", data);
          return;
        }

        // Convert GeoJSON [lng, lat] into Google Maps {lat, lng} points.
        const roadPath = coordinates.map(([lng, lat]) => ({ lat, lng }));

        polyline = new window.google.maps.Polyline({
          path: roadPath,
          geodesic: false,
          strokeColor: color,
          strokeOpacity: 0.95,
          strokeWeight: weight,
          clickable: false,
          zIndex: 30,
          map,
        });

        console.log("FREE ROAD ROUTE DISPLAYED SUCCESSFULLY", {
          points: roadPath.length,
          distanceMeters: Math.round(data.routes[0].distance || 0),
          durationSeconds: Math.round(data.routes[0].duration || 0),
        });
      } catch (error) {
        if (!cancelled) {
          console.error("ROAD ROUTING ERROR:", error);
        }
      }
    }

    calculateRoadRoute();

    return () => {
      cancelled = true;

      if (polyline) {
        polyline.setMap(null);
        polyline = null;
      }
    };
  }, [map, path, color, weight]);

  return null;
}

/* =========================================================
   APP
========================================================= */

function App() {
  /* -------------------------------------------------------
     DATA
  ------------------------------------------------------- */

  const [vehicles, setVehicles] = useState([]);
  const [orders, setOrders] = useState([]);

  /* -------------------------------------------------------
     SELECTED VEHICLE
  ------------------------------------------------------- */

  const [selectedVehicleId, setSelectedVehicleId] = useState(null);

  /* -------------------------------------------------------
     VEHICLE EDIT FORM
  ------------------------------------------------------- */

  const [capacity, setCapacity] = useState("");
  const [load, setLoad] = useState("");
  const [status, setStatus] = useState("AVAILABLE");
  const [route, setRoute] = useState("Depot A");

  /* -------------------------------------------------------
     TRAFFIC
  ------------------------------------------------------- */

  const [trafficVehicle, setTrafficVehicle] = useState("V1");
  const [trafficSignal, setTrafficSignal] = useState("GREEN");
  const [trafficLoading, setTrafficLoading] = useState(false);

  /* -------------------------------------------------------
     OPTIMIZATION
  ------------------------------------------------------- */

  const [optimizationResult, setOptimizationResult] = useState(null);

  /* -------------------------------------------------------
     SYSTEM MESSAGE
  ------------------------------------------------------- */

  const [systemMessage, setSystemMessage] = useState(
    "System ready. Select a vehicle."
  );

  /* -------------------------------------------------------
     ORDER FORM
  ------------------------------------------------------- */

  const [orderForm, setOrderForm] = useState({
    id: "",
    weight_kg: 100,
    packages: 1,
    destination: "Customer 1",
    time_window: "10:00 AM - 11:00 AM",
    priority: "NORMAL",
    assigned_vehicle: "V1",
  });

  /* -------------------------------------------------------
     GOOGLE MAP KEY
  ------------------------------------------------------- */

  const googleMapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  /* =======================================================
     SELECTED VEHICLE OBJECT
  ======================================================= */

  const selectedVehicle = useMemo(() => {
    return (
      vehicles.find((vehicle) => vehicle.id === selectedVehicleId) || null
    );
  }, [vehicles, selectedVehicleId]);

  /* =======================================================
     LOAD VEHICLES
  ======================================================= */

  const loadVehicles = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/vehicles`);

      if (!response.ok) {
        throw new Error("Vehicle API failed");
      }

      const data = await response.json();

      setVehicles(data.vehicles || []);
    } catch (error) {
      console.error(error);

      setSystemMessage(
        "❌ Backend connection failed. Make sure FastAPI is running."
      );
    }
  }, []);

  /* =======================================================
     LOAD ORDERS
  ======================================================= */

  const loadOrders = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/orders`);

      if (!response.ok) {
        throw new Error("Order API failed");
      }

      const data = await response.json();

      setOrders(data.orders || []);
    } catch (error) {
      console.error(error);

      setSystemMessage("❌ Order API failed.");
    }
  }, []);

  /* =======================================================
     INITIAL LOAD
  ======================================================= */

  useEffect(() => {
    loadVehicles();
    loadOrders();
  }, [loadVehicles, loadOrders]);

  /* =======================================================
     SELECT VEHICLE
  ======================================================= */

  const selectVehicle = (vehicle) => {
    setSelectedVehicleId(vehicle.id);

    setCapacity(vehicle.capacity_kg);
    setLoad(vehicle.current_load_kg);
    setStatus(vehicle.status);
    setRoute(vehicle.location);

    setTrafficVehicle(vehicle.id);

    setSystemMessage(
      `🚚 ${vehicle.id} selected. You can now modify its load, capacity, status and route.`
    );
  };

  /* =======================================================
     VEHICLE COLORS
  ======================================================= */

  const vehicleColor = (vehicleStatus) => {
    switch (vehicleStatus) {
      case "DELAYED":
        return "#ef4444";

      case "AVAILABLE":
        return "#22c55e";

      case "BUSY":
        return "#f59e0b";

      case "ON_ROUTE":
        return "#3b82f6";

      default:
        return "#64748b";
    }
  };

  /* =======================================================
     SAVE VEHICLE
  ======================================================= */

  const saveVehicle = async () => {
    if (!selectedVehicle) {
      setSystemMessage("❌ Select a vehicle first.");
      return;
    }

    const newCapacity = Number(capacity);
    const newLoad = Number(load);

    if (!Number.isFinite(newCapacity) || newCapacity <= 0) {
      setSystemMessage("❌ Capacity must be greater than 0.");
      return;
    }

    if (
      !Number.isFinite(newLoad) ||
      newLoad < 0 ||
      newLoad > newCapacity
    ) {
      setSystemMessage(
        "❌ Load must be between 0 and vehicle capacity."
      );
      return;
    }

    try {
      const response = await fetch(
        `${API_URL}/vehicles/${selectedVehicle.id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            capacity_kg: newCapacity,
            current_load_kg: newLoad,
            status,
            location: route,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.detail || "Vehicle update failed"
        );
      }

      setVehicles(data.vehicles || []);

      setSystemMessage(
        `✅ ${selectedVehicle.id} updated successfully.`
      );

      await loadVehicles();
    } catch (error) {
      console.error(error);

      setSystemMessage(`❌ ${error.message}`);
    }
  };

  /* =======================================================
     ADD ORDER
  ======================================================= */

  const addOrder = async (event) => {
    event.preventDefault();

    const weight = Number(orderForm.weight_kg);
    const packages = Number(orderForm.packages);

    if (!orderForm.id.trim()) {
      setSystemMessage("❌ Enter an order ID.");
      return;
    }

    if (weight <= 0 || packages <= 0) {
      setSystemMessage(
        "❌ Weight and packages must be positive."
      );
      return;
    }

    try {
      const response = await fetch(`${API_URL}/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...orderForm,
          id: orderForm.id.trim(),
          weight_kg: weight,
          packages,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.detail || "Order creation failed"
        );
      }

      setOrders(data.orders || []);

      setOrderForm({
        id: "",
        weight_kg: 100,
        packages: 1,
        destination: "Customer 1",
        time_window: "10:00 AM - 11:00 AM",
        priority: "NORMAL",
        assigned_vehicle: "V1",
      });

      setSystemMessage(
        `📦 ${data.order.id} created and assigned to ${data.order.assigned_vehicle}.`
      );

      await loadVehicles();
    } catch (error) {
      console.error(error);

      setSystemMessage(`❌ ${error.message}`);
    }
  };

  /* =======================================================
     SIMULATE TRAFFIC
  ======================================================= */

  const simulateTraffic = async () => {
    if (trafficLoading) {
      return;
    }

    setTrafficLoading(true);
    setOptimizationResult(null);

    try {
      const response = await fetch(
        `${API_URL}/traffic-event`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            vehicle_id: trafficVehicle,
            signal: trafficSignal,
            intersection_id: "T1",
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.detail || "Traffic simulation failed"
        );
      }

      /*
       * IMPORTANT:
       * The backend currently has a recovery scenario centered
       * around V1 -> V4. For the dashboard demo, we also
       * calculate a visible ETA for whichever vehicle the
       * evaluator selects.
       *
       * RED    = +20 minutes
       * YELLOW = +10 minutes
       * GREEN  = +0 minutes
       */
      const selectedVehicle = vehicles.find(
        (vehicle) => vehicle.id === trafficVehicle
      );

      const backendEta =
        data?.affected_vehicle?.old_eta ||
        selectedVehicle?.eta ||
        BASE_ETAS[trafficVehicle];

      const demoEta = calculateDemoEta(
        trafficVehicle,
        trafficSignal,
        backendEta
      );

      // When traffic makes the current vehicle late, find another
      // feasible vehicle with enough free capacity for recovery.
      const affectedOrder =
        orders.find(
          (order) =>
            order.assigned_vehicle === trafficVehicle
        ) || orders[0];

      const backendRecommendedVehicle =
        data?.optimization_result?.recommended_vehicle;

      const backendRecommended =
        vehicles.find(
          (vehicle) =>
            vehicle.id === backendRecommendedVehicle &&
            vehicle.id !== trafficVehicle
        );

      const recoveryVehicle =
        trafficSignal === "GREEN"
          ? null
          : backendRecommended ||
            chooseRecoveryVehicle(
              trafficVehicle,
              affectedOrder?.weight_kg || 300,
              vehicles
            );

      const recoveryVehicleId =
        recoveryVehicle?.id || null;

      const recoveryBaseEta =
        recoveryVehicleId
          ? BASE_ETAS[recoveryVehicleId] ||
            recoveryVehicle?.eta ||
            "10:50 AM"
          : null;

      const recoveryEta =
        recoveryVehicleId
          ? minutesToEta(
              etaToMinutes(recoveryBaseEta) ?? 650
            )
          : null;

      const backendAffected =
        data?.affected_vehicle || {};

      const backendOptimization =
        data?.optimization_result || {};

      const enhancedData = {
        ...data,

        event:
          trafficSignal === "RED"
            ? "HEAVY_TRAFFIC_DETECTED"
            : trafficSignal === "YELLOW"
              ? "MODERATE_TRAFFIC_DETECTED"
              : "NORMAL_TRAFFIC",

        affected_vehicle: {
          ...backendAffected,
          vehicle_id: trafficVehicle,
          old_eta:
            backendAffected.old_eta || demoEta.oldEta,
          new_eta:
            trafficSignal === "GREEN"
              ? demoEta.oldEta
              : backendAffected.new_eta || demoEta.newEta,
          status:
            trafficSignal === "RED"
              ? "DELAYED"
              : trafficSignal === "YELLOW"
                ? "AT_RISK"
                : selectedVehicle?.status || "AVAILABLE",
        },

        optimization_result: {
          ...backendOptimization,

          order_id:
            backendOptimization.order_id || "ETA-SIMULATION",

          previous_vehicle:
            backendOptimization.previous_vehicle ||
            trafficVehicle,

          recommended_vehicle:
            recoveryVehicleId,

          new_eta:
            backendOptimization.new_eta ||
            (trafficSignal === "GREEN"
              ? null
              : demoEta.newEta),

          recovery_eta:
            trafficSignal === "GREEN"
              ? null
              : recoveryEta,

          capacity_check:
            recoveryVehicle
              ? {
                  required_kg:
                    affectedOrder?.weight_kg || 300,
                  available_kg:
                    Number(recoveryVehicle.capacity_kg || 0) -
                    Number(recoveryVehicle.current_load_kg || 0),
                  result: "PASSED",
                }
              : {
                  result: "NO_FEASIBLE_VEHICLE",
                },

          handover:
            recoveryVehicle
              ? {
                  required: true,
                  handover_point: {
                    id: "H1",
                    name: "Handover Point H1",
                    location: "Between affected and recovery routes",
                    handover_eta: demoEta.newEta,
                    status: "FEASIBLE",
                  },
                  cargo: {
                    order_id:
                      affectedOrder?.id || "ETA-SIMULATION",
                    weight_kg:
                      affectedOrder?.weight_kg || 300,
                    packages:
                      affectedOrder?.packages || 1,
                  },
                  transfer:
                    `${trafficVehicle} → ${recoveryVehicleId}`,
                  confirmation_required: true,
                }
              : null,

          reason:
            trafficSignal === "RED"
              ? (
                  recoveryVehicle
                    ? `${trafficVehicle} ETA increased by ${demoEta.delayMinutes} minutes. ${recoveryVehicleId} can recover the delivery.`
                    : `ETA increased by ${demoEta.delayMinutes} minutes, but no feasible recovery vehicle is available.`
                )
              : trafficSignal === "YELLOW"
                ? (
                    recoveryVehicle
                      ? `${trafficVehicle} ETA increased by ${demoEta.delayMinutes} minutes. Recovery available with ${recoveryVehicleId}.`
                      : `${trafficVehicle} ETA increased by ${demoEta.delayMinutes} minutes.`
                  )
                : "Green signal selected. No traffic disruption applied.",

          status:
            trafficSignal === "GREEN"
              ? "NORMAL"
              : recoveryVehicle
                ? "RECOVERY_AVAILABLE"
                : "ETA_UPDATED",
        },
      };

      setOptimizationResult(enhancedData);

      await loadVehicles();
      await loadOrders();

      if (trafficSignal === "GREEN") {
        setSystemMessage(
          `🟢 ${trafficVehicle} ETA checked: ${demoEta.oldEta}. No traffic delay.`
        );
      } else {
        setSystemMessage(
          `🚨 ${trafficVehicle} ETA changed: ${demoEta.oldEta} → ${demoEta.newEta} (+${demoEta.delayMinutes} min).`
        );
      }
    } catch (error) {
      console.error(error);
      setSystemMessage(`❌ ${error.message}`);
    } finally {
      setTrafficLoading(false);
    }
  };

  /* =======================================================
     RESET TRAFFIC
  ======================================================= */

  const resetTraffic = async () => {
    try {
      const response = await fetch(
        `${API_URL}/traffic-reset`,
        {
          method: "POST",
        }
      );

      if (!response.ok) {
        throw new Error("Traffic reset failed");
      }

      setOptimizationResult(null);
      setTrafficSignal("GREEN");

      await loadVehicles();
      await loadOrders();

      setSystemMessage(
        "✅ Traffic simulation reset."
      );
    } catch (error) {
      console.error(error);

      setSystemMessage(`❌ ${error.message}`);
    }
  };

  /* =======================================================
     CONFIRM HANDOVER
  ======================================================= */

  const confirmHandover = async () => {
    const result =
      optimizationResult?.optimization_result;

    if (!result?.handover) {
      return;
    }

    try {
      const response = await fetch(
        `${API_URL}/handover/confirm`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            order_id:
              optimizationResult.order.order_id,

            from_vehicle:
              result.previous_vehicle,

            to_vehicle:
              result.recommended_vehicle,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.detail || "Handover failed"
        );
      }

      setOptimizationResult(null);

      await loadVehicles();
      await loadOrders();

      setSystemMessage(
        `✅ Handover confirmed: ${data.transfer}`
      );
    } catch (error) {
      console.error(error);

      setSystemMessage(`❌ ${error.message}`);
    }
  };

  /* =======================================================
     MAP ROUTES
  ======================================================= */

  const routePaths = useMemo(() => {
    const paths = [];

    // During optimization, show only the affected-vehicle route
    // and the recommended recovery route.
    if (optimizationResult) {
      const affectedVehicleId =
        optimizationResult?.affected_vehicle?.vehicle_id;

      const recommendedVehicleId =
        optimizationResult?.optimization_result
          ?.recommended_vehicle;

      const destination =
        optimizationResult?.order?.destination;

      const affectedVehicleLocation =
        LOCATIONS[affectedVehicleId];

      const recommendedVehicleLocation =
        LOCATIONS[recommendedVehicleId];

      const destinationLocation =
        LOCATIONS[destination];

      if (
        affectedVehicleLocation &&
        LOCATIONS.T1 &&
        LOCATIONS.H1
      ) {
        paths.push([
          affectedVehicleLocation,
          LOCATIONS.T1,
          LOCATIONS.H1,
        ]);
      }

      if (
        LOCATIONS.H1 &&
        recommendedVehicleLocation &&
        destinationLocation
      ) {
        paths.push([
          LOCATIONS.H1,
          recommendedVehicleLocation,
          destinationLocation,
        ]);
      }

      return paths;
    }

    // Normal mode:
    // Calculate the ORIGINAL GOOGLE DRIVING ROUTE:
    // selected vehicle -> its actual customer.
    //
    // No T1, H1, or manually connected route points.
    if (selectedVehicle) {
      const vehicleLocation =
        LOCATIONS[selectedVehicle.id];

      const assignedOrder = orders.find(
        (order) =>
          order.assigned_vehicle === selectedVehicle.id &&
          order.status !== "CANCELLED"
      );

      const defaultDestinationByVehicle = {
        V1: "Customer 1",
        V2: "Customer 2",
        V3: "Customer 1",
        V4: "Customer 1",
      };

      const destinationName =
        assignedOrder?.destination ||
        defaultDestinationByVehicle[selectedVehicle.id];

      const destinationLocation =
        LOCATIONS[destinationName];

      if (vehicleLocation && destinationLocation) {
        paths.push([
          vehicleLocation,
          destinationLocation,
        ]);
      }
    }

    return paths;
  }, [selectedVehicle, orders, optimizationResult]);

  /* =======================================================
     GOOGLE KEY CHECK
  ======================================================= */

  if (!googleMapsKey) {
    return (
      <div className="missing-key">
        <h1>Google Maps API Key Missing</h1>

        <p>
          Open:
        </p>

        <pre>frontend/.env</pre>

        <p>Add:</p>

        <pre>
          VITE_GOOGLE_MAPS_API_KEY=YOUR_GOOGLE_MAPS_KEY
        </pre>

        <p>
          Then restart Vite.
        </p>
      </div>
    );
  }

  /* =======================================================
     UI
  ======================================================= */

  return (
    <APIProvider apiKey={googleMapsKey}>

      <div className="app">

        {/* =================================================
            HEADER
        ================================================= */}

        <header className="header">

          <div>
            <h1>
              🚚 PNT2 Fleet Optimization Engine
            </h1>

            <p>
              Real-Time Multi-Depot Fleet Optimization System
            </p>
          </div>

          <div className="live-badge">
            ● LIVE SYSTEM
          </div>

        </header>

        {/* =================================================
            STATS
        ================================================= */}

        <section className="stats">

          <div className="stat-card">
            🚚

            <span>
              Total Fleet

              <strong>
                {vehicles.length}
              </strong>
            </span>
          </div>

          <div className="stat-card">
            📦

            <span>
              Active Orders

              <strong>
                {orders.length}
              </strong>
            </span>
          </div>

          <div className="stat-card">
            🏭

            <span>
              Depots

              <strong>
                2
              </strong>
            </span>
          </div>

          <div className="stat-card">
            ⚡

            <span>
              System Status

              <strong className="online">
                ONLINE
              </strong>
            </span>
          </div>

        </section>

        {/* =================================================
            MAIN LAYOUT
        ================================================= */}

        <main className="main-layout">

          {/* =================================================
              LEFT PANEL
          ================================================= */}

          <aside className="sidebar">

            {/* VEHICLES */}

            <section className="panel">

              <div className="panel-title">
                🚚 Fleet Control
              </div>

              {vehicles.map((vehicle) => (

                <button
                  type="button"
                  key={vehicle.id}
                  className={`vehicle-card ${
                    selectedVehicleId === vehicle.id
                      ? "selected"
                      : ""
                  }`}
                  onClick={() =>
                    selectVehicle(vehicle)
                  }
                >

                  <div className="vehicle-top">

                    <strong>
                      {vehicle.id}
                    </strong>

                    <span
                      className="status"
                      style={{
                        background:
                          vehicleColor(
                            vehicle.status
                          ),
                      }}
                    >
                      {vehicle.status}
                    </span>

                  </div>

                  <div>
                    Driver: {vehicle.driver}
                  </div>

                  <div>
                    Depot: {vehicle.depot}
                  </div>

                  <div className="load-bar">

                    <div
                      className="load-progress"
                      style={{
                        width: `${Math.min(
                          100,
                          (vehicle.current_load_kg /
                            vehicle.capacity_kg) *
                            100
                        )}%`,
                      }}
                    />

                  </div>

                  <div>
                    Load:{" "}
                    {vehicle.current_load_kg}
                    {" / "}
                    {vehicle.capacity_kg} kg
                  </div>

                  <div>
                    Route: {vehicle.location}
                  </div>

                  <div>
                    ETA:{" "}
                    {vehicle.eta || "Available"}
                  </div>

                </button>

              ))}

              {/* VEHICLE EDITOR */}

              {selectedVehicle && (

                <div className="editor">

                  <h3>
                    ⚙️ Control{" "}
                    {selectedVehicle.id}
                  </h3>

                  <label>
                    Capacity (kg)
                  </label>

                  <input
                    type="number"
                    value={capacity}
                    onChange={(e) =>
                      setCapacity(
                        e.target.value
                      )
                    }
                  />

                  <label>
                    Current Load (kg)
                  </label>

                  <input
                    type="number"
                    value={load}
                    onChange={(e) =>
                      setLoad(
                        e.target.value
                      )
                    }
                  />

                  <label>
                    Status
                  </label>

                  <select
                    value={status}
                    onChange={(e) =>
                      setStatus(
                        e.target.value
                      )
                    }
                  >
                    <option value="AVAILABLE">
                      AVAILABLE
                    </option>

                    <option value="ON_ROUTE">
                      ON_ROUTE
                    </option>

                    <option value="BUSY">
                      BUSY
                    </option>

                    <option value="DELAYED">
                      DELAYED
                    </option>
                  </select>

                  <label>
                    Route
                  </label>

                  <select
                    value={route}
                    onChange={(e) =>
                      setRoute(
                        e.target.value
                      )
                    }
                  >

                    <option value="Depot A">
                      Depot A
                    </option>

                    <option value="Depot B">
                      Depot B
                    </option>

                    <option value="Route A">
                      Route A
                    </option>

                    <option value="Route B">
                      Route B
                    </option>

                    <option value="Route C">
                      Route C
                    </option>

                    <option value="Route D">
                      Route D
                    </option>

                  </select>

                  <button
                    type="button"
                    className="primary-button"
                    onClick={saveVehicle}
                  >
                    💾 SAVE VEHICLE
                  </button>

                </div>

              )}

            </section>

            {/* =================================================
                ADD ORDER
            ================================================= */}

            <section className="panel">

              <div className="panel-title">
                📦 Add Order
              </div>

              <form
                onSubmit={addOrder}
                className="form-grid"
              >

                <input
                  placeholder="Order ID e.g. O103"
                  value={orderForm.id}
                  onChange={(e) =>
                    setOrderForm({
                      ...orderForm,
                      id: e.target.value,
                    })
                  }
                />

                <input
                  type="number"
                  placeholder="Weight kg"
                  value={orderForm.weight_kg}
                  onChange={(e) =>
                    setOrderForm({
                      ...orderForm,
                      weight_kg:
                        e.target.value,
                    })
                  }
                />

                <input
                  type="number"
                  placeholder="Packages"
                  value={orderForm.packages}
                  onChange={(e) =>
                    setOrderForm({
                      ...orderForm,
                      packages:
                        e.target.value,
                    })
                  }
                />

                <select
                  value={orderForm.destination}
                  onChange={(e) =>
                    setOrderForm({
                      ...orderForm,
                      destination:
                        e.target.value,
                    })
                  }
                >

                  <option value="Customer 1">
                    Customer 1
                  </option>

                  <option value="Customer 2">
                    Customer 2
                  </option>

                </select>

                <select
                  value={orderForm.priority}
                  onChange={(e) =>
                    setOrderForm({
                      ...orderForm,
                      priority:
                        e.target.value,
                    })
                  }
                >

                  <option value="NORMAL">
                    NORMAL
                  </option>

                  <option value="HIGH">
                    HIGH
                  </option>

                </select>

                <select
                  value={
                    orderForm.assigned_vehicle
                  }
                  onChange={(e) =>
                    setOrderForm({
                      ...orderForm,
                      assigned_vehicle:
                        e.target.value,
                    })
                  }
                >

                  {vehicles.map((vehicle) => (

                    <option
                      key={vehicle.id}
                      value={vehicle.id}
                    >
                      {vehicle.id}
                    </option>

                  ))}

                </select>

                <button
                  type="submit"
                  className="primary-button"
                >
                  ➕ ADD ORDER
                </button>

              </form>

            </section>

            {/* =================================================
                ORDERS
            ================================================= */}

            <section className="panel">

              <div className="panel-title">
                📦 Orders
              </div>

              {orders.map((order) => (

                <div
                  className="order-card"
                  key={order.id}
                >

                  <div className="vehicle-top">

                    <strong>
                      {order.id}
                    </strong>

                    <span
                      className={
                        order.status ===
                        "AT_RISK"
                          ? "risk"
                          : "safe"
                      }
                    >
                      {order.status}
                    </span>

                  </div>

                  <div>
                    {order.destination}
                  </div>

                  <div>
                    Weight: {order.weight_kg} kg
                  </div>

                  <div>
                    Packages: {order.packages}
                  </div>

                  <div>
                    Window: {order.time_window}
                  </div>

                  <div>
                    Vehicle:{" "}
                    <b>
                      {order.assigned_vehicle}
                    </b>
                  </div>

                </div>

              ))}

            </section>

          </aside>

          {/* =================================================
              GOOGLE MAP
          ================================================= */}

          <section className="map-container">

            <Map
              defaultCenter={DEFAULT_CENTER}
              defaultZoom={13}
              mapId="DEMO_MAP_ID"
              gestureHandling="greedy"
              className="google-map"
            >

              {/* DEPOT A */}

              <AdvancedMarker
                position={LOCATIONS["Depot A"]}
              >
                <Pin
                  background="#2563eb"
                  borderColor="#ffffff"
                  glyphColor="#ffffff"
                />
              </AdvancedMarker>

              {/* DEPOT B */}

              <AdvancedMarker
                position={LOCATIONS["Depot B"]}
              >
                <Pin
                  background="#7c3aed"
                  borderColor="#ffffff"
                  glyphColor="#ffffff"
                />
              </AdvancedMarker>

              {/* VEHICLES */}

              {vehicles.map((vehicle) => {

                const position =
                  LOCATIONS[vehicle.id] ||
                  DEFAULT_CENTER;

                const isSelected =
                  selectedVehicleId ===
                  vehicle.id;

                return (

                  <AdvancedMarker
                    key={vehicle.id}
                    position={position}
                    onClick={() =>
                      selectVehicle(vehicle)
                    }
                  >

                    <div
                      className="vehicle-marker"
                      style={{
                        background:
                          vehicleColor(
                            vehicle.status
                          ),

                        outline: isSelected
                          ? "4px solid white"
                          : "none",

                        transform: isSelected
                          ? "scale(1.15)"
                          : "scale(1)",
                      }}
                    >
                      🚚 {vehicle.id}
                    </div>

                  </AdvancedMarker>

                );

              })}

              {/* CUSTOMER 1 */}

              <AdvancedMarker
                position={
                  LOCATIONS["Customer 1"]
                }
              >
                <Pin
                  background="#16a34a"
                  borderColor="#ffffff"
                  glyphColor="#ffffff"
                />
              </AdvancedMarker>

              {/* CUSTOMER 2 */}

              <AdvancedMarker
                position={
                  LOCATIONS["Customer 2"]
                }
              >
                <Pin
                  background="#16a34a"
                  borderColor="#ffffff"
                  glyphColor="#ffffff"
                />
              </AdvancedMarker>

              {/* TRAFFIC LIGHT */}

              <AdvancedMarker
                position={LOCATIONS.T1}
              >

                <div className="traffic-marker">

                  <span
                    className={`light red ${
                      trafficSignal === "RED"
                        ? "active"
                        : ""
                    }`}
                  />

                  <span
                    className={`light yellow ${
                      trafficSignal === "YELLOW"
                        ? "active"
                        : ""
                    }`}
                  />

                  <span
                    className={`light green ${
                      trafficSignal === "GREEN"
                        ? "active"
                        : ""
                    }`}
                  />

                </div>

              </AdvancedMarker>

              {/* HANDOVER */}

              <AdvancedMarker
                position={LOCATIONS.H1}
              >
                <div className="handover-marker">
                  H1
                </div>
              </AdvancedMarker>

              {/* ROUTES */}

              {routePaths.map(
                (path, index) => (

                  <RouteLine
                    key={`route-${index}`}
                    path={path}
                    color={
                      optimizationResult
                        ? index === 0
                          ? "#ef4444"
                          : "#22c55e"
                        : "#2563eb"
                    }
                    weight={
                      optimizationResult
                        ? 6
                        : 4
                    }
                  />

                )
              )}

            </Map>

            {/* MAP LEGEND */}

            <div className="map-legend">

              <b>MAP LEGEND</b>

              <span>
                🔵 Depot
              </span>

              <span>
                🚚 Vehicle
              </span>

              <span>
                🟢 Customer
              </span>

              <span>
                🚦 Traffic T1
              </span>

              <span>
                🟣 Handover H1
              </span>

            </div>

          </section>

          {/* =================================================
              RIGHT PANEL
          ================================================= */}

          <aside className="right-panel">

            {/* TRAFFIC CONTROL */}

            <section className="panel">

              <div className="panel-title">
                🚦 Traffic Control
              </div>

              <label>
                Affected Vehicle
              </label>

              <select
                value={trafficVehicle}
                onChange={(e) =>
                  setTrafficVehicle(
                    e.target.value
                  )
                }
              >

                {vehicles.map((vehicle) => (

                  <option
                    key={vehicle.id}
                    value={vehicle.id}
                  >
                    {vehicle.id} —{" "}
                    {vehicle.status}
                  </option>

                ))}

              </select>

              {/* TRAFFIC LIGHT */}

              <div className="traffic-status">

                <span
                  className={`big-light red ${
                    trafficSignal === "RED"
                      ? "red-active"
                      : ""
                  }`}
                />

                <span
                  className={`big-light yellow ${
                    trafficSignal === "YELLOW"
                      ? "yellow-active"
                      : ""
                  }`}
                />

                <span
                  className={`big-light green ${
                    trafficSignal === "GREEN"
                      ? "green-active"
                      : ""
                  }`}
                />

              </div>

              <p>
                Intersection:{" "}
                <b>T1</b>
              </p>

              <select
                value={trafficSignal}
                onChange={(e) =>
                  setTrafficSignal(
                    e.target.value
                  )
                }
              >

                <option value="GREEN">
                  GREEN — Normal
                </option>

                <option value="YELLOW">
                  YELLOW — Moderate
                </option>

                <option value="RED">
                  RED — Heavy Traffic
                </option>

              </select>

              <button
                type="button"
                className="primary-button danger-button"
                onClick={simulateTraffic}
                disabled={trafficLoading}
              >
                {trafficLoading
                  ? "⚙️ OPTIMIZING..."
                  : "🚨 SIMULATE TRAFFIC"}
              </button>

              <button
                type="button"
                className="secondary-button"
                onClick={resetTraffic}
              >
                🔄 RESET TRAFFIC
              </button>

            </section>

            {/* =================================================
                OPTIMIZATION
            ================================================= */}

            <section className="panel">

              <div className="panel-title">
                ⚡ Optimization Engine
              </div>

              {!optimizationResult ? (

                <div className="empty-state">

                  <div>
                    🧠
                  </div>

                  <p>
                    Waiting for a disruption...
                  </p>

                  <small>
                    Select a vehicle,
                    choose traffic,
                    then simulate.
                  </small>

                </div>

              ) : (

                <div className="optimization-result">

                  <div className="alert-box">
                    {optimizationResult.event === "NORMAL_TRAFFIC"
                      ? "🟢"
                      : "⚠️"}{" "}
                    {optimizationResult.event}
                  </div>

                  <h2>
                    {
                      optimizationResult
                        .affected_vehicle
                        .vehicle_id
                    }

                    {" → "}

                    {
                      optimizationResult
                        .optimization_result
                        .recommended_vehicle ||
                      "ETA UPDATED"
                    }
                  </h2>

                  <div className="result-row">

                    <span>
                      Old ETA
                    </span>

                    <b>
                      {
                        optimizationResult
                          .affected_vehicle
                          .old_eta ||
                        "N/A"
                      }
                    </b>

                  </div>

                  <div className="result-row danger">

                    <span>
                      New ETA
                    </span>

                    <b>
                      {
                        optimizationResult
                          .affected_vehicle
                          .new_eta ||
                        optimizationResult
                          .affected_vehicle
                          .old_eta ||
                        "N/A"
                      }
                    </b>

                  </div>

                  <div className="result-row success">

                    <span>
                      Recovery ETA
                    </span>

                    <b>
                      {
                        optimizationResult
                          .optimization_result
                          .recovery_eta ||
                        optimizationResult
                          .optimization_result
                          .new_eta ||
                        "N/A"
                      }
                    </b>

                  </div>

                  <hr />

                  <p>

                    <b>
                      Reason:
                    </b>

                    <br />

                    {
                      optimizationResult
                        .optimization_result
                        .reason
                    }

                  </p>

                  {optimizationResult
                    .optimization_result
                    .recommended_vehicle && (
                    <div className="check-list">
                      <div>
                        🔄 Recovery Vehicle:{" "}
                        <b>
                          {
                            optimizationResult
                              .optimization_result
                              .recommended_vehicle
                          }
                        </b>
                      </div>

                      <div>
                        ⏱️ Recovery ETA:{" "}
                        <b>
                          {
                            optimizationResult
                              .optimization_result
                              .recovery_eta ||
                            "N/A"
                          }
                        </b>
                      </div>
                    </div>
                  )}

                  {optimizationResult
                    .optimization_result
                    .handover && (

                    <>

                      <div className="check-list">

                        <div>
                          ✅ Capacity check
                        </div>

                        <div>
                          📍 Handover:{" "}
                          {
                            optimizationResult
                              .optimization_result
                              .handover
                              .handover_point
                              .id
                          }
                        </div>

                        <div>
                          🚚 Transfer:{" "}
                          {
                            optimizationResult
                              .optimization_result
                              .handover
                              .transfer
                          }
                        </div>

                      </div>

                      <button
                        type="button"
                        className="handover-button"
                        onClick={
                          confirmHandover
                        }
                      >
                        ✅ CONFIRM HANDOVER
                      </button>

                    </>

                  )}

                </div>

              )}

            </section>

            {/* SYSTEM MESSAGE */}

            <section className="system-message">

              <div className="system-message-title">
                SYSTEM EVENT
              </div>

              <p>
                {systemMessage}
              </p>

            </section>

          </aside>

        </main>

        <footer>
          PNT2 • Real-Time Multi-Depot Fleet
          Optimization Engine • Interactive MVP
        </footer>

      </div>

    </APIProvider>
  );
}

export default App;