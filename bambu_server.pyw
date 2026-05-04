"""
Bambu P2S OBS Overlay Server (Direct MQTT)
Connects directly to your printer via paho-mqtt for full data access.

SETUP:
1. pip install paho-mqtt flask flask-cors
2. Fill in your printer details below
3. Run: python bambu_server.py
4. Add http://localhost:5000/overlay as a Browser Source in OBS
"""

import json
import ssl
import threading
import time

import paho.mqtt.client as mqtt
from flask import Flask, jsonify, send_file
from flask_cors import CORS

# ─── CONFIGURE YOUR PRINTER HERE ──────────────────────────────────────────────
PRINTER_IP     = "ENTER YOUR PRINTER IP HERE"       # Your printer's local IP address
PRINTER_SERIAL = "ENTER YOUR SERIAL NUMBER HERE"     # Your serial number
ACCESS_CODE    = "ENTER YOUR ACCESS CODE HERE"           # Found in: Printer screen → Settings → LAN
# ──────────────────────────────────────────────────────────────────────────────

MQTT_PORT      = 8883
MQTT_USERNAME  = "bblp"
REPORT_TOPIC   = f"device/{PRINTER_SERIAL}/report"
REQUEST_TOPIC  = f"device/{PRINTER_SERIAL}/request"

app = Flask(__name__)
CORS(app)

# Shared state updated by MQTT callbacks
state = {
    "connected": False,
    "status": "Connecting...",
    "progress": 0,
    "layer_current": 0,
    "layer_total": 0,
    "time_remaining_min": 0,
    "nozzle_temp": 0.0,
    "nozzle_target": 0.0,
    "bed_temp": 0.0,
    "bed_target": 0.0,
    "filename": "",
    "print_stage": "idle",
    "last_updated": 0,
    "ams": [],
}

def format_time(minutes):
    if minutes <= 0:
        return "—"
    h = minutes // 60
    m = minutes % 60
    return f"{h}h {m:02d}m" if h > 0 else f"{m}m"

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print("✅ Connected to printer MQTT!")
        state["connected"] = True
        # Subscribe to the report topic
        client.subscribe(REPORT_TOPIC)
        # Ask the printer to send a full status update
        push_cmd = json.dumps({"pushing": {"sequence_id": "0", "command": "start"}})
        client.publish(REQUEST_TOPIC, push_cmd)
    else:
        codes = {
            1: "Incorrect protocol version",
            2: "Invalid client ID",
            3: "Server unavailable",
            4: "Bad credentials — check your Access Code",
            5: "Not authorized",
        }
        print(f"❌ Connection failed: {codes.get(rc, f'Code {rc}')}")
        state["connected"] = False

def on_disconnect(client, userdata, rc):
    print("⚠️  Disconnected from printer, will retry...")
    state["connected"] = False

def on_message(client, userdata, msg):
    try:
        data = json.loads(msg.payload.decode())
        print_data = data.get("print", {})

        if not print_data:
            return

        # Temperatures
        if "nozzle_temper" in print_data:
            state["nozzle_temp"] = round(float(print_data["nozzle_temper"]), 1)
        if "nozzle_target_temper" in print_data:
            state["nozzle_target"] = round(float(print_data["nozzle_target_temper"]), 1)
        if "bed_temper" in print_data:
            state["bed_temp"] = round(float(print_data["bed_temper"]), 1)
        if "bed_target_temper" in print_data:
            state["bed_target"] = round(float(print_data["bed_target_temper"]), 1)

        # Progress and time
        if "mc_percent" in print_data:
            state["progress"] = int(print_data["mc_percent"])
        if "mc_remaining_time" in print_data:
            state["time_remaining_min"] = int(print_data["mc_remaining_time"])

        # Layers
        if "layer_num" in print_data:
            state["layer_current"] = int(print_data["layer_num"])
        if "total_layer_num" in print_data:
            state["layer_total"] = int(print_data["total_layer_num"])

        # Status
        if "gcode_state" in print_data:
            state["status"] = print_data["gcode_state"]
        if "mc_print_stage" in print_data:
            state["print_stage"] = print_data["mc_print_stage"]

        # Filename
        if "gcode_file" in print_data:
            state["filename"] = print_data["gcode_file"].split("/")[-1]
        elif "subtask_name" in print_data:
            state["filename"] = print_data["subtask_name"]

        # AMS
        if "ams" in print_data:
            ams_data = print_data["ams"].get("ams", [])
            slots = []
            for unit in ams_data:
                for tray in unit.get("tray", []):
                    slots.append({
                        "id": tray.get("id"),
                        "type": tray.get("tray_type", ""),
                        "color": "#" + tray.get("tray_color", "FFFFFF")[:6],
                        "active": False,
                    })
            # Mark active slot
            active = print_data.get("ams", {}).get("tray_now", "-1")
            for slot in slots:
                if str(slot["id"]) == str(active):
                    slot["active"] = True
            if slots:
                state["ams"] = slots

        state["last_updated"] = int(time.time())

    except Exception as e:
        print(f"Error parsing message: {e}")

def mqtt_thread():
    while True:
        try:
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)
            client.username_pw_set(MQTT_USERNAME, ACCESS_CODE)

            # P1/P2 series uses TLS on port 8883
            tls_ctx = ssl.create_default_context()
            tls_ctx.check_hostname = False
            tls_ctx.verify_mode = ssl.CERT_NONE
            client.tls_set_context(tls_ctx)

            client.on_connect    = on_connect
            client.on_disconnect = on_disconnect
            client.on_message    = on_message

            print(f"Connecting to {PRINTER_IP}:{MQTT_PORT}...")
            client.connect(PRINTER_IP, MQTT_PORT, keepalive=60)
            client.loop_forever()

        except Exception as e:
            print(f"MQTT error: {e}, retrying in 10s...")
            state["connected"] = False
            time.sleep(10)

@app.route("/api/status")
def api_status():
    data = dict(state)
    data["time_remaining_fmt"] = format_time(data["time_remaining_min"])
    return jsonify(data)

@app.route("/overlay")
def overlay():
    return send_file("bambu_overlay.html")

@app.route("/")
def root():
    return """
    <h2>Bambu Overlay Server Running ✅</h2>
    <p><a href="/overlay">Open Overlay</a></p>
    <p><a href="/api/status">Raw JSON Data</a></p>
    """

if __name__ == "__main__":
    if "XXX" in PRINTER_IP or "YOUR_" in ACCESS_CODE:
        print("\n⚠️  Please fill in your printer's IP and Access Code at the top of this file!\n")
    else:
        t = threading.Thread(target=mqtt_thread, daemon=True)
        t.start()
        print(f"\n✅ Bambu Overlay Server starting...")
        print(f"   Connecting to printer at {PRINTER_IP}")
        print(f"   Add to OBS Browser Source: http://localhost:5000/overlay\n")

    app.run(host="0.0.0.0", port=5000, debug=False)
