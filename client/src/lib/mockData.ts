import { addDays, subDays, format, subMinutes } from "date-fns";

export interface Line {
  id: string;
  name: string;
  direction: string;
}

export interface Stop {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface JourneyDelayPoint {
  stopName: string;
  scheduledTime: string;
  actualTime: string;
  delaySeconds: number;
}

export const LINES: Line[] = [
  { id: "3", name: "3 Støbotn - Sletten", direction: "South" },
  { id: "4", name: "4 Hesjaholtet - Flaktveit", direction: "North" },
  { id: "6", name: "6 Birkelundstoppen - Lyngbø", direction: "West" },
  { id: "12", name: "12 Montana - Lønborglien", direction: "North" },
  { id: "50E", name: "50E Bergen - Straume", direction: "West" },
  { id: "Bybanen 1", name: "1 Bergen Lufthavn - Bergen Sentrum", direction: "Center" },
];

export const STOPS: Stop[] = [
  { id: "festplassen", name: "Festplassen", lat: 60.3913, lng: 5.3261 },
  { id: "olav_kyrres", name: "Olav Kyrres gate", lat: 60.3920, lng: 5.3240 },
  { id: "asane_term", name: "Åsane Terminal", lat: 60.4680, lng: 5.3230 },
  { id: "oasen_term", name: "Oasen Terminal", lat: 60.3600, lng: 5.3300 },
  { id: "lagunen", name: "Lagunen Terminal", lat: 60.2980, lng: 5.3330 },
  { id: "byparken", name: "Byparken", lat: 60.3925, lng: 5.3275 },
  { id: "flesland", name: "Bergen Lufthavn", lat: 60.2930, lng: 5.2180 },
  { id: "danmarksplass", name: "Danmarksplass", lat: 60.3780, lng: 5.3340 },
  { id: "nhh", name: "NHH", lat: 60.4230, lng: 5.3040 },
  { id: "bryggen", name: "Bryggen", lat: 60.3975, lng: 5.3245 },
];

export const getGeneralStats = (period: string) => {
  return {
    avgDelay: period === "week" ? 2.4 : 3.1,
    worstJourney: {
      line: "6",
      departure: "16:15",
      date: subDays(new Date(), 2),
      totalDelay: 18,
    },
    worstLine: { id: "6", name: "6 Birkelundstoppen", avgDelay: 5.2 },
    bestLine: { id: "Bybanen 1", name: "1 Bergen Lufthavn", avgDelay: 0.3 },
    totalDepartures: 14502,
    delayedDepartures: 3240,
    dataValidityScore: 88, // % of departures with realtime data
  };
};

export const getWeeklyDelayTrend = () => {
  const data = [];
  for (let i = 6; i >= 0; i--) {
    const date = subDays(new Date(), i);
    data.push({
      date: format(date, "EEE"),
      avgDelay: Math.floor(Math.random() * 4) + 1 + Math.random(),
      cancellations: Math.floor(Math.random() * 5),
    });
  }
  return data;
};

export const getWorstJourneyData = (): JourneyDelayPoint[] => {
  const stops = ["Birkelundstoppen", "Mannsverk", "Haukeland", "Bergen Busstasjon", "Festplassen", "Olav Kyrres gate", "Dokken", "Laksevåg", "Lyngbø"];
  let currentDelay = 0;
  return stops.map((stop, index) => {
    if (index > 2 && index < 6) currentDelay += Math.floor(Math.random() * 5) + 2;
    if (index > 6) currentDelay -= Math.floor(Math.random() * 2);
    if (currentDelay < 0) currentDelay = 0;
    return {
      stopName: stop,
      scheduledTime: `16:${15 + index * 5}`,
      actualTime: `16:${15 + index * 5 + Math.floor(currentDelay)}`,
      delaySeconds: currentDelay * 60,
    };
  });
};

export const getJourneyStats = (lineId: string, time: string) => {
  const baseDelay = Math.random() * 5;
  const isRushHour = time.startsWith("07") || time.startsWith("08") || time.startsWith("15") || time.startsWith("16");
  const multiplier = isRushHour ? 2.5 : 1.0;
  return {
    avgDelay: (baseDelay * multiplier).toFixed(1),
    punctuality: Math.floor(100 - (baseDelay * multiplier * 5)),
    cancellations: Math.random() > 0.9 ? 1 : 0,
    trend: getWorstJourneyData().map(p => ({
      ...p,
      delaySeconds: Math.max(0, p.delaySeconds * (Math.random() + 0.5))
    }))
  };
};

export const getWorstDays = () => {
  return [
    { date: "2025-01-14", reason: "Snow Storm", avgDelay: 12.5, cancellations: 145 },
    { date: "2025-12-02", reason: "Traffic Accident - E39", avgDelay: 8.2, cancellations: 42 },
    { date: "2025-11-20", reason: "Heavy Rain", avgDelay: 6.1, cancellations: 12 },
    { date: "2025-10-31", reason: "Friday Rush", avgDelay: 5.8, cancellations: 8 },
    { date: "2025-09-15", reason: "Road Work", avgDelay: 5.4, cancellations: 5 },
  ];
};

export const getWorstStops = () => {
  return [
    { name: "Olav Kyrres gate", totalDelayMinutes: 4520, delayedDeparturesPct: 42 },
    { name: "Bryggen", totalDelayMinutes: 3800, delayedDeparturesPct: 38 },
    { name: "Danmarksplass", totalDelayMinutes: 3100, delayedDeparturesPct: 35 },
    { name: "Åsane Terminal", totalDelayMinutes: 2800, delayedDeparturesPct: 22 },
    { name: "Festplassen", totalDelayMinutes: 2500, delayedDeparturesPct: 28 },
  ];
};

export const getStopStats = (stopId: string) => {
  return {
    name: STOPS.find(s => s.id === stopId)?.name || stopId,
    avgDelay: 3.2,
    departures: 120,
    delayed: 45,
    lines: LINES.map(l => ({
      ...l,
      avgDelayAtStop: Math.floor(Math.random() * 5),
    })).sort((a, b) => b.avgDelayAtStop - a.avgDelayAtStop),
  };
};

export const getMapData = () => {
  return STOPS.map(stop => ({
    ...stop,
    avgDelay: (Math.random() * 6).toFixed(1),
    dataQuality: Math.floor(Math.random() * 40) + 60,
  }));
};
