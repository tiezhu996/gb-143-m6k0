import { SERVICE_TYPE_WEIGHTS, POINTS_PER_HOUR } from '../types';

export const getServiceTypeWeight = (serviceType: string): number => {
  const typeConfig = SERVICE_TYPE_WEIGHTS.find(t => t.type === serviceType);
  return typeConfig ? typeConfig.weight : 1.0;
};

export const calculatePoints = (
  durationHours: number,
  serviceType: string,
  rating: number
): number => {
  const weight = getServiceTypeWeight(serviceType);
  const ratingBonus = (rating - 3) * 0.1;
  const basePoints = durationHours * POINTS_PER_HOUR * weight;
  const finalPoints = Math.round(basePoints * (1 + ratingBonus));
  return Math.max(1, finalPoints);
};

export const calculateNoShowPenalty = (): number => {
  return 20;
};
