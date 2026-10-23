import { systemPreferences, type WebContents } from 'electron';

export function configureVoicePermissions(contents: WebContents, pageUrl: string) {
  const trusted = (web: WebContents | null, url: string) =>
    web === contents && contents.getURL() === pageUrl && url === pageUrl;
  contents.session.setPermissionCheckHandler(
    (web, permission, origin, details) =>
      permission === 'media' &&
      trusted(web, details.requestingUrl ?? origin) &&
      details.mediaType === 'audio',
  );
  contents.session.setPermissionRequestHandler((web, permission, callback, details) => {
    const media = 'mediaTypes' in details ? details.mediaTypes : undefined;
    if (
      permission !== 'media' ||
      !trusted(web, details.requestingUrl) ||
      !media?.length ||
      media.some((type) => type !== 'audio')
    ) {
      callback(false);
      return;
    }
    if (process.platform === 'darwin') {
      void systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
    } else callback(true);
  });
}
