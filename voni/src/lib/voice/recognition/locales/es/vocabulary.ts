/**
 * Spanish vocabulary: the neutral terms a Spanish call is primed with.
 *
 * "Voni" and "WhatsApp" are the product's and the channel's own names, so they
 * keep their spelling in every Locale. Everything else is Spanish: the words a
 * caller uses for the line and the handset it arrives on. No English common
 * word belongs here — a Spanish repertoire primed with English teaches the
 * recogniser the wrong language.
 *
 * The other slots (scene, digits, address, filler, bargeIn, commands, endCall,
 * goodbye) are holes in `./index.ts` until their own files land; this file
 * holds vocabulary only.
 */
export const ES_VOCABULARY: readonly string[] = ["Voni", "WhatsApp", "teléfono", "móvil"];
