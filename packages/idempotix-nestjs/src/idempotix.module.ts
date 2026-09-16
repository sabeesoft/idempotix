import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type Provider,
  type Type,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotixInterceptor } from './idempotix.interceptor.js';
import { IdempotixService } from './idempotix.service.js';
import { IDEMPOTIX_OPTIONS, resolveOptions, type IdempotixModuleOptions } from './options.js';

export interface IdempotixModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: (string | symbol | Type<unknown>)[];
  useFactory: (...deps: never[]) => IdempotixModuleOptions | Promise<IdempotixModuleOptions>;
}

@Module({})
export class IdempotixModule {
  static forRoot(options: IdempotixModuleOptions): DynamicModule {
    return IdempotixModule.build([
      { provide: IDEMPOTIX_OPTIONS, useValue: resolveOptions(options) },
    ]);
  }

  static forRootAsync(options: IdempotixModuleAsyncOptions): DynamicModule {
    return IdempotixModule.build(
      [
        {
          provide: IDEMPOTIX_OPTIONS,
          inject: options.inject ?? [],
          useFactory: async (...deps: never[]) => resolveOptions(await options.useFactory(...deps)),
        },
      ],
      options.imports,
    );
  }

  private static build(
    optionProviders: Provider[],
    imports: ModuleMetadata['imports'] = [],
  ): DynamicModule {
    return {
      module: IdempotixModule,
      global: true,
      imports,
      providers: [
        ...optionProviders,
        IdempotixService,
        { provide: APP_INTERCEPTOR, useClass: IdempotixInterceptor },
      ],
      exports: [IDEMPOTIX_OPTIONS, IdempotixService],
    };
  }
}
