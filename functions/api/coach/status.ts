import { coachStatus, type CoachApiContext } from '../../lib/radian-api/coach-routes';

export const onRequestGet = (context: CoachApiContext): Promise<Response> => coachStatus(context);
