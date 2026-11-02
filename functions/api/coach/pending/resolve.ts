import { resolveCoachProposal, type CoachApiContext } from '../../../lib/radian-api/coach-routes';

export const onRequestPost = (context: CoachApiContext): Promise<Response> => resolveCoachProposal(context);
