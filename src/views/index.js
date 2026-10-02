import dashboard from './dashboard.js';
import screener from './screener.js';
import newWheel from './newWheel.js';
import wheels from './wheels.js';
import recovery from './recovery.js';
import roll from './roll.js';
import journal from './journal.js';
import learn from './learn.js';
import settings from './settings.js';
import { putGuide, callGuide } from './guides.js';

export const views = { dashboard, screener, new: newWheel, wheels, recovery, roll, journal, learn, putguide: putGuide, callguide: callGuide, settings };
export const DEFAULT_VIEW = 'dashboard';
