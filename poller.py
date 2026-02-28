import os
import time
import requests
import datetime
from sqlalchemy.orm import Session
from database import SessionLocal, WeatherRecord, Station

API_KEY = "6532d6454b8aa370768e63d6ba5a832e"
POLL_INTERVAL_SECONDS = 30

# Global state to track changes between polls
LAST_STATE = {} 

def get_color_val(val, prev, fmt_spec=".1f", suffix=""):
    if val is None:
        return "—".center(8)
    
    val_str = f"{val:{fmt_spec}}{suffix}"
    if prev is None:
        return f"\033[94m{val_str:<8}\033[0m" # Blue for first poll
    
    if abs(val - prev) < 0.0001:
        return f"\033[90m{val_str:<8}\033[0m" # Gray for steady
    
    if val > prev:
        return f"\033[92m{val_str + '+':<8}\033[0m" # Green for increase
    
    return f"\033[91m{val_str + '-':<8}\033[0m" # Red for decrease

def print_weather_table(stations_data):
    # Clear screen might be too disruptive with uvicorn, so we'll just print a header
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"\n\033[1mWeather Poll Results - {now}\033[0m")
    header = f"{'Station':<12} | {'Temp':<8} | {'Hum':<8} | {'Wind':<8} | {'Press':<8} | {'Rain':<8} | {'UV':<8}"
    print("-" * len(header))
    print(header)
    print("-" * len(header))
    
    for sid, data in stations_data:
        prev = LAST_STATE.get(sid, {})
        
        t = get_color_val(data.get('temperature'), prev.get('temperature'), suffix="°F")
        h = get_color_val(data.get('humidity'), prev.get('humidity'), fmt_spec=".0f", suffix="%")
        w = get_color_val(data.get('wind_speed'), prev.get('wind_speed'), suffix="mph")
        p = get_color_val(data.get('pressure'), prev.get('pressure'), fmt_spec=".2f")
        r = get_color_val(data.get('precip_total'), prev.get('precip_total'), fmt_spec=".2f", suffix='"')
        uv = get_color_val(data.get('uv_index'), prev.get('uv_index'), fmt_spec=".1f")
        
        print(f"{sid:<12} | {t} | {h} | {w} | {p} | {r} | {uv}")
        
        # Update state
        LAST_STATE[sid] = data
    print("-" * len(header))

def fetch_current_weather(station_id):
    url = f"https://api.weather.com/v2/pws/observations/current?stationId={station_id}&format=json&units=e&apiKey={API_KEY}"
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        if response.status_code == 204:
            return None
        data = response.json()
        if 'observations' in data and len(data['observations']) > 0:
            obs = data['observations'][0]
            metric = obs.get('imperial', {})

            return {
                "station_id": station_id,
                "timestamp": datetime.datetime.fromisoformat(obs.get('obsTimeUtc').replace('Z', '+00:00')).replace(tzinfo=None),
                "temperature": metric.get('temp'),
                "humidity": obs.get('humidity'),
                "dew_point": metric.get('dewpt'),
                "heat_index": metric.get('heatIndex'),
                "wind_chill": metric.get('windChill'),
                "wind_speed": metric.get('windSpeed'),
                "wind_dir": obs.get('winddir'),
                "wind_gust": metric.get('windGust'),
                "pressure": metric.get('pressure'),
                "precip_rate": metric.get('precipRate'),
                "precip_total": metric.get('precipTotal'),
                "solar_radiation": obs.get('solarRadiation'),
                "uv_index": obs.get('uv'),
                "lat": obs.get('lat'),
                "lon": obs.get('lon'),
                "name": obs.get('neighborhood')
            }
    except Exception as e:
        print(f"Error fetching current weather for {station_id}: {e}")
    return None

def fetch_historical_weather(station_id, date_str):
    url = f"https://api.weather.com/v2/pws/history/all?stationId={station_id}&format=json&units=e&date={date_str}&apiKey={API_KEY}"
    records = []
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        if response.status_code == 204:
            return records
        data = response.json()
        if 'observations' in data:
            for obs in data['observations']:
                metric = obs.get('imperial', {})
                records.append({
                    "station_id": station_id,
                    "timestamp": datetime.datetime.fromisoformat(obs.get('obsTimeUtc').replace('Z', '+00:00')).replace(tzinfo=None),
                    "temperature": metric.get('tempAvg'),
                    "humidity": obs.get('humidityAvg'),
                    "dew_point": metric.get('dewptAvg'),
                    "heat_index": metric.get('heatindexAvg'),
                    "wind_chill": metric.get('windchillAvg'),
                    "wind_speed": metric.get('windspeedAvg'),
                    "wind_dir": obs.get('winddirAvg'),
                    "wind_gust": metric.get('windgustAvg'),
                    "pressure": metric.get('pressureMax'),
                    "precip_rate": metric.get('precipRate'),
                    "precip_total": metric.get('precipTotal'),
                    "solar_radiation": obs.get('solarRadiationHigh'),
                    "uv_index": obs.get('uvHigh')
                })
    except Exception as e:
        print(f"Error fetching historical weather for {station_id} {date_str}: {e}")
    return records

def fetch_recent_24h_weather(station_id):
    url = f"https://api.weather.com/v2/pws/observations/all/1day?stationId={station_id}&format=json&units=e&apiKey={API_KEY}"
    records = []
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        if response.status_code == 204:
            return records
        data = response.json()
        if 'observations' in data:
            for obs in data['observations']:
                metric = obs.get('imperial', {})
                records.append({
                    "station_id": station_id,
                    "timestamp": datetime.datetime.fromisoformat(obs.get('obsTimeUtc').replace('Z', '+00:00')).replace(tzinfo=None),
                    "temperature": metric.get('tempAvg'),
                    "humidity": obs.get('humidityAvg'),
                    "dew_point": metric.get('dewptAvg'),
                    "heat_index": metric.get('heatindexAvg'),
                    "wind_chill": metric.get('windchillAvg'),
                    "wind_speed": metric.get('windspeedAvg'),
                    "wind_dir": obs.get('winddirAvg'),
                    "wind_gust": metric.get('windgustAvg'),
                    "pressure": metric.get('pressureMax'),
                    "precip_rate": metric.get('precipRate'),
                    "precip_total": metric.get('precipTotal'),
                    "solar_radiation": obs.get('solarRadiationHigh'),
                    "uv_index": obs.get('uvHigh')
                })
    except Exception as e:
        print(f"Error fetching recent 24h weather for {station_id}: {e}")
    return records


def save_weather_record(db: Session, record_data: dict):
    # Filter keys to only include what WeatherRecord expects
    allowed_keys = {c.name for c in WeatherRecord.__table__.columns}
    filtered_data = {k: v for k, v in record_data.items() if k in allowed_keys}
    
    existing = db.query(WeatherRecord).filter(
        WeatherRecord.station_id == filtered_data.get('station_id'),
        WeatherRecord.timestamp == filtered_data['timestamp']
    ).first()
    if not existing:
        db_record = WeatherRecord(**filtered_data)
        db.add(db_record)
        db.commit()
        db.refresh(db_record)
        return db_record
    return existing

def backfill(days=5, verbose=False, station_id=None):
    db = SessionLocal()
    try:
        if station_id:
            stations = db.query(Station).filter(Station.id == station_id.upper()).all()
        else:
            stations = db.query(Station).all()
            
        for s in stations:
            current_sid = s.id
            if verbose:
                print(f"Checking backfill for {current_sid} over last {days} days...")
            print(f"Starting {days}-day backfill check for {current_sid}...")
            today = datetime.datetime.now(datetime.UTC).date()
            for i in range(days):
                past_date = today - datetime.timedelta(days=i)
                date_str = past_date.strftime("%Y%m%d")
                if verbose:
                    print(f"  Requesting data for {current_sid} on {date_str}...")
                records = fetch_historical_weather(current_sid, date_str)
                if verbose:
                    print(f"  Received {len(records)} records for {current_sid} on {date_str}")
                for rec in records:
                    save_weather_record(db, rec)
                time.sleep(1)
            
            # Supplement with sliding 24h high-res data to fill recent gaps
            if verbose:
                print(f"  Fetching sliding 24h records for {current_sid}...")
            recent_records = fetch_recent_24h_weather(current_sid)
            if verbose:
                print(f"  Received {len(recent_records)} sliding 24h records for {current_sid}")
            for rec in recent_records:
                save_weather_record(db, rec)
                
            print(f"Backfill complete for {current_sid}.")
    finally:
        db.close()

def repair_database(days=5, verbose=False):
    db = SessionLocal()
    try:
        print("Starting database repair: Searching for corrupt records (NULL temperature)...")
        corrupt_query = db.query(WeatherRecord).filter(WeatherRecord.temperature == None)
        count = corrupt_query.count()
        if count > 0:
            print(f"  Found {count} corrupt records. Deleting...")
            corrupt_query.delete(synchronize_session=False)
            db.commit()
            print("  Deletion successful.")
        else:
            print("  No corrupt records found.")
        
        print(f"Proceeding to backfill for last {days} days to ensure completeness...")
        backfill(days=days, verbose=verbose)
    except Exception as e:
        print(f"Error during database repair: {e}")
        db.rollback()
    finally:
        db.close()

def poll_loop(do_backfill=True, backfill_days=5, verbose=False):
    print("Starting poller thread...")
    # Initial pause to let DB seed
    time.sleep(2)
    if do_backfill:
        backfill(days=backfill_days, verbose=verbose)
    print("Starting background polling loop...")
    while True:
        db = SessionLocal()
        poll_results = []
        try:
            stations = db.query(Station).all()
            for s in stations:
                station_id = s.id
                record_data = fetch_current_weather(station_id)
                if record_data:
                    # Sync metadata if it changed
                    updated = False
                    if record_data.get('lat') and abs((s.latitude or 0) - record_data['lat']) > 0.0001:
                        s.latitude = record_data['lat']
                        updated = True
                    if record_data.get('lon') and abs((s.longitude or 0) - record_data['lon']) > 0.0001:
                        s.longitude = record_data['lon']
                        updated = True
                    if record_data.get('name') and s.name != record_data['name']:
                        s.name = record_data['name']
                        updated = True
                    
                    if updated:
                        db.commit()
                        if verbose:
                            print(f"Updated metadata for {station_id}: {s.name} ({s.latitude}, {s.longitude})")

                    save_weather_record(db, record_data)
                    poll_results.append((station_id, record_data))
                elif verbose:
                    print(f"No data returned for {station_id}")
                time.sleep(1)  # small delay between stations
            
            if poll_results:
                print_weather_table(poll_results)
                
        except Exception as e:
            print(f"Polling loop encountered error: {e}")
        finally:
            db.close()
        time.sleep(POLL_INTERVAL_SECONDS)

if __name__ == "__main__":
    poll_loop()
