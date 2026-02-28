import os
import threading
import datetime
import sys
import argparse
from typing import Optional, List
from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from sqlalchemy import desc, func
from pydantic import BaseModel, ConfigDict
from jose import JWTError, jwt
from passlib.context import CryptContext

from database import SessionLocal, WeatherRecord, User, Station, engine, Base
import poller
import requests as http_requests

# ── Auth Configuration ───────────────────────────────────────────────────────
SECRET_KEY = "super-secret-key-for-weather-dashboard"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 # 1 day

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/auth/token")

# ── Pydantic Models ──────────────────────────────────────────────────────────
class Token(BaseModel):
    access_token: str
    token_type: str

class TokenData(BaseModel):
    username: Optional[str] = None

class UserOut(BaseModel):
    username: str
    is_admin: bool
    model_config = ConfigDict(from_attributes=True)

class UserCreate(BaseModel):
    username: str
    password: str

class StationCreate(BaseModel):
    id: str
    name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class StationOut(BaseModel):
    id: str
    name: str
    latitude: float
    longitude: float
    model_config = ConfigDict(from_attributes=True)

# ── API Setup ────────────────────────────────────────────────────────────────
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables
    Base.metadata.create_all(bind=engine)
    
    db = SessionLocal()
    # Seed Admin
    admin = db.query(User).filter(User.username == "admin").first()
    if not admin:
        admin = User(
            username="admin", 
            hashed_password=get_password_hash("admin"),
            is_admin=True
        )
        db.add(admin)
    
    # Seed Initial Stations if empty
    if db.query(Station).count() == 0:
        initial_stations = [
            Station(id="KALMILLP10", name="Millport Primary", latitude=33.544, longitude=-88.133),
            Station(id="KALKENNE5",  name="Kennedy Station",  latitude=33.705, longitude=-87.974),
            Station(id="KALMILLP8",  name="Millport Alt",     latitude=33.540, longitude=-88.100),
        ]
        db.add_all(initial_stations)
    
    db.commit()
    db.close()
    
    # Optional Database Repair (deletes nulls and triggers backfill)
    if BACKFILL_OPTS["do_repair"]:
        poller.repair_database(days=BACKFILL_OPTS["days"], verbose=BACKFILL_OPTS["verbose"])
        # If we repaired, backfill is already done by repair_database.
        # Set do_backfill to False for the poller thread to avoid double work.
        BACKFILL_OPTS["do_backfill"] = False

    # Start Poller
    thread = threading.Thread(
        target=poller.poll_loop, 
        args=(BACKFILL_OPTS["do_backfill"], BACKFILL_OPTS["days"], BACKFILL_OPTS["verbose"]),
        daemon=True
    )
    thread.start()
    yield

app = FastAPI(title="Weather Dashboard API", lifespan=lifespan)

WU_API_KEY = "6532d6454b8aa370768e63d6ba5a832e"

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ── Auth Helpers ─────────────────────────────────────────────────────────────
def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password):
    return pwd_context.hash(password)

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.datetime.now(datetime.UTC) + datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

async def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
        token_data = TokenData(username=username)
    except JWTError:
        raise credentials_exception
    user = db.query(User).filter(User.username == token_data.username).first()
    if user is None:
        raise credentials_exception
    return user

async def get_current_admin(current_user: User = Depends(get_current_user)):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return current_user

# ── CLI Configuration ──────────────────────────────────────────────────────────
# Global variable to store backfill setting
BACKFILL_OPTS = {"do_backfill": True, "days": 5, "verbose": False, "do_repair": False}

# ── Startup/Seeding ──────────────────────────────────────────────────────────

# ── Auth Endpoints ──────────────────────────────────────────────────────────
@app.post("/api/auth/signup", response_model=UserOut)
def signup(user: UserCreate, db: Session = Depends(get_db)):
    db_user = db.query(User).filter(User.username == user.username).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Username already registered")
    new_user = User(
        username=user.username,
        hashed_password=get_password_hash(user.password),
        is_admin=False
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user

@app.post("/api/auth/token", response_model=Token)
async def login_for_access_token(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token = create_access_token(data={"sub": user.username})
    return {"access_token": access_token, "token_type": "bearer"}

@app.get("/api/auth/me", response_model=UserOut)
async def read_users_me(current_user: User = Depends(get_current_user)):
    return current_user

# ── Station Management ───────────────────────────────────────────────────────
@app.get("/api/stations", response_model=List[StationOut])
def list_stations(db: Session = Depends(get_db)):
    return db.query(Station).all()

@app.post("/api/stations", response_model=StationOut)
def create_station(station: StationCreate, db: Session = Depends(get_db), admin: User = Depends(get_current_admin)):
    sid = station.id.upper()
    db_station = db.query(Station).filter(Station.id == sid).first()
    if db_station:
        raise HTTPException(status_code=400, detail="Station already exists")
    
    name = station.name
    lat = station.latitude
    lon = station.longitude

    # Auto-fetch metadata if missing
    if not lat or not lon or not name:
        try:
            r = http_requests.get(
                f"https://api.weather.com/v2/pws/observations/current?stationId={sid}&format=json&units=e&apiKey={WU_API_KEY}",
                timeout=10
            )
            if r.status_code == 200:
                data = r.json()
                if 'observations' in data and len(data['observations']) > 0:
                    obs = data['observations'][0]
                    if not lat: lat = obs.get('lat')
                    if not lon: lon = obs.get('lon')
                    if not name: name = obs.get('neighborhood') or sid
            elif r.status_code == 404:
                raise HTTPException(status_code=404, detail="Station ID not found on Weather Underground")
        except HTTPException:
            raise
        except Exception as e:
            print(f"Metadata lookup failed for {sid}: {e}")

    if not lat or not lon:
        raise HTTPException(status_code=400, detail="Could not retrieve location for this station ID. Please provide lat/lon manually.")

    new_station = Station(
        id=sid,
        name=name or sid,
        latitude=lat,
        longitude=lon
    )
    db.add(new_station)
    db.commit()
    db.refresh(new_station)
    
    # Start background backfill for the new station
    backfill_thread = threading.Thread(
        target=poller.backfill, 
        kwargs={"days": 5, "station_id": new_station.id, "verbose": True},
        daemon=True
    )
    backfill_thread.start()
    
    return new_station

@app.delete("/api/stations/{station_id}")
def delete_station(station_id: str, db: Session = Depends(get_db), admin: User = Depends(get_current_admin)):
    db_station = db.query(Station).filter(Station.id == station_id.upper()).first()
    if not db_station:
        raise HTTPException(status_code=404, detail="Station not found")
    db.delete(db_station)
    db.commit()
    return {"detail": "Station deleted"}

# ── Dynamic Fetching (Helper) ────────────────────────────────────────────────
def get_station_info(station_id: str, db: Session):
    s = db.query(Station).filter(Station.id == station_id.upper()).first()
    if not s:
        # Fallback to hardcoded if not in DB for some reason (backward compatibility)
        return {"lat": 33.544, "lon": -88.133}
    return {"lat": s.latitude, "lon": s.longitude}

# ── Current observation ──────────────────────────────────────────────────────
@app.get("/api/current")
def get_current_weather(station: str = "KALMILLP10", db: Session = Depends(get_db)):
    record = db.query(WeatherRecord).filter(
        WeatherRecord.station_id == station.upper()
    ).order_by(desc(WeatherRecord.timestamp)).first()
    if record is None:
        raise HTTPException(status_code=404, detail="No data yet for " + station)
    return {
        "station_id": record.station_id,
        "obs_time_utc": record.timestamp.strftime("%Y-%m-%dT%H:%M:%SZ") if record.timestamp else None,
        "temp_f": record.temperature,
        "humidity_pct": record.humidity,
        "dew_point_f": record.dew_point,
        "heat_index_f": record.heat_index,
        "wind_chill_f": record.wind_chill,
        "wind_speed_mph": record.wind_speed,
        "wind_dir_deg": record.wind_dir,
        "wind_gust_mph": record.wind_gust,
        "pressure_in": record.pressure,
        "precip_rate_in_hr": record.precip_rate,
        "precip_total_in": record.precip_total,
        "solar_radiation_wm2": record.solar_radiation,
        "uv_index": record.uv_index,
    }

# ── History ──────────────────────────────────────────────────────────────────
@app.get("/api/history")
def get_weather_history(
    station: str = "KALMILLP10",
    hours: int = 24,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 500,
    db: Session = Depends(get_db)
):
    query = db.query(WeatherRecord).filter(WeatherRecord.station_id == station.upper())

    if start and end:
        try:
            start_dt = datetime.datetime.fromisoformat(start.replace('Z', '+00:00')).replace(tzinfo=None)
            end_dt = datetime.datetime.fromisoformat(end.replace('Z', '+00:00')).replace(tzinfo=None)
            query = query.filter(WeatherRecord.timestamp >= start_dt, WeatherRecord.timestamp <= end_dt)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid datetime format.")
    else:
        cutoff = datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=hours)
        query = query.filter(WeatherRecord.timestamp >= cutoff)

    records = query.order_by(WeatherRecord.timestamp).limit(limit).all()
    return [{
        "obs_time_utc": r.timestamp.strftime("%Y-%m-%dT%H:%M:%SZ") if r.timestamp else None,
        "temp_f": r.temperature,
        "humidity_pct": r.humidity,
        "dew_point_f": r.dew_point,
        "heat_index_f": r.heat_index,
        "wind_chill_f": r.wind_chill,
        "wind_speed_mph": r.wind_speed,
        "wind_dir_deg": r.wind_dir,
        "wind_gust_mph": r.wind_gust,
        "pressure_in": r.pressure,
        "precip_rate_in_hr": r.precip_rate,
        "precip_total_in": r.precip_total,
        "solar_radiation_wm2": r.solar_radiation,
        "uv_index": r.uv_index,
    } for r in records]

# ── Today summary ────────────────────────────────────────────────────────────
@app.get("/api/today")
def get_today_summary(station: str = "KALMILLP10", db: Session = Depends(get_db)):
    today_start = datetime.datetime.now(datetime.UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    records = db.query(WeatherRecord).filter(
        WeatherRecord.station_id == station.upper(),
        WeatherRecord.timestamp >= today_start
    ).all()
    if not records:
        return None
    temps = [r.temperature for r in records if r.temperature is not None]
    humids = [r.humidity for r in records if r.humidity is not None]
    pressures = [r.pressure for r in records if r.pressure is not None]
    gusts = [r.wind_gust for r in records if r.wind_gust is not None]
    rains = [r.precip_total for r in records if r.precip_total is not None]
    uvs = [r.uv_index for r in records if r.uv_index is not None]
    solars = [r.solar_radiation for r in records if r.solar_radiation is not None]
    return {
        "temp_high_f": max(temps) if temps else None,
        "temp_low_f": min(temps) if temps else None,
        "temp_avg_f": round(sum(temps)/len(temps), 1) if temps else None,
        "humidity_high": max(humids) if humids else None,
        "humidity_low": min(humids) if humids else None,
        "pressure_avg": round(sum(pressures)/len(pressures), 2) if pressures else None,
        "wind_gust_max": max(gusts) if gusts else None,
        "rain_total": max(rains) if rains else None,
        "uv_max": max(uvs) if uvs else None,
        "solar_max": max(solars) if solars else None,
        "reading_count": len(records),
    }

# ── Daily summary (last 30 days) ────────────────────────────────────────────
@app.get("/api/daily")
def get_daily_summary(station: str = "KALMILLP10", days: int = 30, db: Session = Depends(get_db)):
    cutoff = datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=days)
    records = db.query(WeatherRecord).filter(
        WeatherRecord.station_id == station.upper(),
        WeatherRecord.timestamp >= cutoff
    ).order_by(WeatherRecord.timestamp).all()

    from collections import defaultdict
    by_day = defaultdict(list)
    for r in records:
        if r.timestamp:
            by_day[r.timestamp.strftime("%Y-%m-%d")].append(r)

    result = []
    for day in sorted(by_day.keys(), reverse=True):
        recs = by_day[day]
        temps = [r.temperature for r in recs if r.temperature is not None]
        humids = [r.humidity for r in recs if r.humidity is not None]
        pressures = [r.pressure for r in recs if r.pressure is not None]
        gusts = [r.wind_gust for r in recs if r.wind_gust is not None]
        rains = [r.precip_total for r in recs if r.precip_total is not None]
        uvs = [r.uv_index for r in recs if r.uv_index is not None]
        result.append({
            "day": day,
            "temp_high_f": max(temps) if temps else None,
            "temp_low_f": min(temps) if temps else None,
            "temp_avg_f": round(sum(temps)/len(temps), 1) if temps else None,
            "humidity_high": max(humids) if humids else None,
            "humidity_low": min(humids) if humids else None,
            "pressure_avg": round(sum(pressures)/len(pressures), 2) if pressures else None,
            "wind_gust_max": max(gusts) if gusts else None,
            "rain_total": max(rains) if rains else None,
            "uv_max": max(uvs) if uvs else None,
            "reading_count": len(recs),
        })
    return result

# ── NWS Alerts ───────────────────────────────────────────────────────────────
@app.get("/api/alerts")
def get_nws_alerts(station: str = "KALMILLP10", db: Session = Depends(get_db)):
    info = get_station_info(station, db)
    try:
        r = http_requests.get(
            f"https://api.weather.gov/alerts/active?point={info['latitude'] if 'latitude' in info else info['lat']},{info['longitude'] if 'longitude' in info else info['lon']}",
            headers={"User-Agent": "WeatherDashboard/1.0"},
            timeout=10
        )
        r.raise_for_status()
        data = r.json()
        alerts = []
        for feature in data.get("features", []):
            props = feature.get("properties", {})
            alerts.append({
                "event": props.get("event"),
                "severity": props.get("severity"),
                "headline": props.get("headline"),
                "description": props.get("description"),
                "expires": props.get("expires"),
            })
        return alerts
    except Exception:
        return []

# ── Nearby Stations ──────────────────────────────────────────────────────────
@app.get("/api/nearby")
def get_nearby_stations(station: str = "KALMILLP10", db: Session = Depends(get_db)):
    info = get_station_info(station, db)
    try:
        r = http_requests.get(
            f"https://api.weather.com/v2/pws/observations/all/1day?geocode={info['latitude'] if 'latitude' in info else info['lat']},{info['longitude'] if 'longitude' in info else info['lon']}&format=json&units=e&apiKey={WU_API_KEY}",
            timeout=10
        )
        r.raise_for_status()
        if r.status_code == 204:
            return []
        data = r.json()
        stations = []
        for obs in data.get("observations", []):
            stations.append({
                "stationID": obs.get("stationID"),
                "neighborhood": obs.get("neighborhood"),
                "lat": obs.get("lat"),
                "lon": obs.get("lon"),
                "temp_f": obs.get("imperial", {}).get("temp"),
                "humidity": obs.get("humidity"),
                "wind_speed": obs.get("imperial", {}).get("windSpeed"),
            })
        seen = set()
        unique = []
        for s in stations:
            if s["stationID"] not in seen:
                seen.add(s["stationID"])
                unique.append(s)
        return unique[:20]
    except Exception:
        return []

# ── Forecast ───────────────────────────────────────────────────────────────
@app.get("/api/forecast")
def get_forecast(station: str = "KALMILLP10", db: Session = Depends(get_db)):
    info = get_station_info(station, db)
    lat = info.get('latitude') or info.get('lat')
    lon = info.get('longitude') or info.get('lon')
    
    try:
        # 1. Get gridpoints
        r_points = http_requests.get(
            f"https://api.weather.gov/points/{lat},{lon}",
            headers={"User-Agent": "WeatherDashboard/1.0"},
            timeout=10
        )
        r_points.raise_for_status()
        points_data = r_points.json()
        forecast_url = points_data.get("properties", {}).get("forecast")
        
        if not forecast_url:
            return []
            
        # 2. Get forecast
        r_forecast = http_requests.get(
            forecast_url,
            headers={"User-Agent": "WeatherDashboard/1.0"},
            timeout=10
        )
        r_forecast.raise_for_status()
        forecast_data = r_forecast.json()
        
        periods = forecast_data.get("properties", {}).get("periods", [])
        return periods[:14] # Next 7 days (day/night per day)
    except Exception as e:
        print(f"Forecast error for {station}: {e}")
        return []

# ── Static files ─────────────────────────────────────────────────────────────
os.makedirs("static/css", exist_ok=True)
os.makedirs("static/js", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def read_root():
    return FileResponse("static/index.html")

@app.get("/login")
def login_page():
    return FileResponse("static/login.html")

@app.get("/signup")
def signup_page():
    return FileResponse("static/signup.html")

if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser(description="Weather Dashboard Server")
    parser.add_argument("--no-backfill", action="store_false", dest="backfill", help="Disable automatic backfill of missing data")
    parser.add_argument("--days", type=int, default=5, help="Number of days to backfill (default: 5)")
    parser.add_argument("--last-48h", action="store_true", help="Backfill only the last 48 hours")
    parser.add_argument("--verbose", "-v", action="store_true", help="Enable verbose logging")
    parser.add_argument("--repair-db", action="store_true", help="Delete corrupt records and trigger backfill")
    parser.set_defaults(backfill=True)
    args, unknown = parser.parse_known_args()
    
    BACKFILL_OPTS["do_backfill"] = args.backfill
    BACKFILL_OPTS["days"] = args.days
    if args.last_48h and args.days == 5: # If user didn't explicitly set --days, use 2 for --last-48h
        BACKFILL_OPTS["days"] = 2
    BACKFILL_OPTS["verbose"] = args.verbose
    BACKFILL_OPTS["do_repair"] = args.repair_db
    
    uvicorn.run(app, host="0.0.0.0", port=8000)
