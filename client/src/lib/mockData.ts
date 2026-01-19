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

export const REGIONAL_STOPS: Record<string, Stop[]> = {
  vestland: [
    { id: "festplassen", name: "Festplassen", lat: 60.3913, lng: 5.3261 },
    { id: "olav_kyrres", name: "Olav Kyrres gate", lat: 60.3920, lng: 5.3240 },
    { id: "asane_term", name: "Åsane Terminal", lat: 60.4680, lng: 5.3230 },
    { id: "oasen_term", name: "Oasen Terminal", lat: 60.3600, lng: 5.3300 },
    { id: "lagunen", name: "Lagunen Terminal", lat: 60.2980, lng: 5.3330 },
  ],
  oslo: [
    { id: "jernbanetorget", name: "Jernbanetorget", lat: 59.9125, lng: 10.7508 },
    { id: "nationaltheatret", name: "Nationaltheatret", lat: 59.9144, lng: 10.7320 },
    { id: "majorstuen", name: "Majorstuen", lat: 59.9298, lng: 10.7145 },
    { id: "helsfyr", name: "Helsfyr", lat: 59.9122, lng: 10.8066 },
    { id: "lyshaker", name: "Lysaker", lat: 59.9128, lng: 10.6358 },
  ],
  viken: [
    { id: "drammen_sentrum", name: "Drammen Sentrum", lat: 59.7441, lng: 10.2045 },
    { id: "lillestrom_st", name: "Lillestrøm Stasjon", lat: 59.9538, lng: 11.0477 },
    { id: "sandvika", name: "Sandvika", lat: 59.8911, lng: 10.5230 },
  ],
  rogaland: [
    { id: "stavanger_sentrum", name: "Stavanger Sentrum", lat: 58.9694, lng: 5.7331 },
    { id: "sandnes_sentrum", name: "Sandnes Sentrum", lat: 58.8524, lng: 5.7352 },
  ],
  trondelag: [
    { id: "trondheim_s", name: "Trondheim S", lat: 63.4368, lng: 10.3995 },
    { id: "munkegata", name: "Munkegata", lat: 63.4305, lng: 10.3951 },
  ]
};

export const STOPS: Stop[] = Object.values(REGIONAL_STOPS).flat();

export const getGeneralStats = (period: string, region: string = "vestland") => {
  const seed = region.length;
  return {
    avgDelay: period === "week" ? 2.4 + (seed % 2) : 3.1 + (seed % 2),
    worstJourney: {
      line: "6",
      departure: "16:15",
      date: subDays(new Date(), 2),
      totalDelay: 18 + seed,
    },
    worstLine: { id: "6", name: "6 Birkelundstoppen", avgDelay: 5.2 + (seed / 10) },
    bestLine: { id: "Bybanen 1", name: "1 Bergen Lufthavn", avgDelay: 0.3 },
    totalDepartures: 14502 + (seed * 100),
    delayedDepartures: 3240 + (seed * 20),
    dataValidityScore: 85 + (seed % 10),
  };
};

export const getWeeklyDelayTrend = (region: string = "vestland") => {
  const data = [];
  const seed = region.length;
  for (let i = 6; i >= 0; i--) {
    const date = subDays(new Date(), i);
    data.push({
      date: format(date, "EEE"),
      avgDelay: (Math.floor(Math.random() * 4) + 1 + Math.random()) * (1 + seed/20),
      cancellations: Math.floor(Math.random() * 5),
    });
  }
  return data;
};

export const getWorstJourneyData = (): JourneyDelayPoint[] => {
  const stops = ["Start Point", "Midway 1", "City Center", "Midway 2", "End Point"];
  let currentDelay = 0;
  return stops.map((stop, index) => {
    if (index > 1) currentDelay += Math.floor(Math.random() * 5) + 1;
    return {
      stopName: stop,
      scheduledTime: `12:${15 + index * 10}`,
      actualTime: `12:${15 + index * 10 + Math.floor(currentDelay)}`,
      delaySeconds: currentDelay * 60,
    };
  });
};

export const getJourneyStats = (lineId: string, time: string) => {
  const baseDelay = Math.random() * 5;
  return {
    avgDelay: baseDelay.toFixed(1),
    punctuality: Math.floor(100 - (baseDelay * 5)),
    cancellations: Math.random() > 0.9 ? 1 : 0,
    trend: getWorstJourneyData()
  };
};

export const getWorstDays = () => {
  return [
    { date: "2025-01-14", reason: "Weather", avgDelay: 12.5, cancellations: 145 },
    { date: "2025-12-02", reason: "Traffic", avgDelay: 8.2, cancellations: 42 },
  ];
};

export const getWorstStops = (region: string = "vestland") => {
  const stops = REGIONAL_STOPS[region] || REGIONAL_STOPS.vestland;
  return stops.slice(0, 5).map(s => ({
    name: s.name,
    totalDelayMinutes: Math.floor(Math.random() * 4000) + 1000,
    delayedDeparturesPct: Math.floor(Math.random() * 40) + 10,
  })).sort((a, b) => b.totalDelayMinutes - a.totalDelayMinutes);
};

export const getStopStats = (stopId: string) => {
  const stop = STOPS.find(s => s.id === stopId);
  return {
    name: stop?.name || stopId,
    avgDelay: 3.2,
    departures: 120,
    delayed: 45,
    lines: LINES.map(l => ({
      ...l,
      avgDelayAtStop: Math.floor(Math.random() * 5),
    })).sort((a, b) => b.avgDelayAtStop - a.avgDelayAtStop),
  };
};

export const getMapData = (region: string = "vestland") => {
  const stops = REGIONAL_STOPS[region] || REGIONAL_STOPS.vestland;
  return stops.map(stop => ({
    ...stop,
    avgDelay: (Math.random() * 6).toFixed(1),
    dataQuality: Math.floor(Math.random() * 20) + 80,
  }));
};
