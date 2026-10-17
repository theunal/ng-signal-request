import '@angular/compiler';
import { NgModule, provideZonelessChangeDetection } from '@angular/core';
import { getTestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';

@NgModule({ providers: [provideZonelessChangeDetection()] })
// An empty `NgModule` is the Angular idiom for "this module exists only to carry providers", which
// is exactly what this one is.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class ZonelessTestModule {}

getTestBed().initTestEnvironment(
  [BrowserTestingModule, ZonelessTestModule],
  platformBrowserTesting(),
  {
    teardown: { destroyAfterEach: true },
  },
);
