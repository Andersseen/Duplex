import { provideFileRouter } from '@analogjs/router';
import type { ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';
import { withComponentInputBinding } from '@angular/router';
import { provideVoltTheme } from '@voltui/components';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideFileRouter(withComponentInputBinding()),
    provideClientHydration(withEventReplay()),
    provideVoltTheme({ color: 'volt', style: 'sharp', dark: false }),
  ],
};
