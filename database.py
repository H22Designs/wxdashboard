from sqlalchemy import create_engine, Column, Integer, Float, String, DateTime, Boolean, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
import datetime

DATABASE_URL = "sqlite:///./weather.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    is_admin = Column(Boolean, default=False)

class Station(Base):
    __tablename__ = "stations"
    id = Column(String, primary_key=True, index=True) # Station ID (e.g. KALMILLP10)
    name = Column(String)
    latitude = Column(Float)
    longitude = Column(Float)
    created_at = Column(DateTime, default=lambda: datetime.datetime.now(datetime.UTC))

class WeatherRecord(Base):
    __tablename__ = "weather_records"

    id = Column(Integer, primary_key=True, index=True)
    station_id = Column(String, index=True)
    timestamp = Column(DateTime, index=True)
    
    # Metrics
    temperature = Column(Float)
    humidity = Column(Float)
    dew_point = Column(Float)
    heat_index = Column(Float)
    wind_chill = Column(Float)
    wind_speed = Column(Float)
    wind_dir = Column(Float)
    wind_gust = Column(Float)
    pressure = Column(Float)
    precip_rate = Column(Float)
    precip_total = Column(Float)
    solar_radiation = Column(Float)
    uv_index = Column(Float)

def init_db():
    Base.metadata.create_all(bind=engine)
