import Noco from "../Noco";
import {Result, NcConfig} from "../../../interface/config";
import {RestApiBuilder} from "../rest/RestApiBuilder";
import {GqlApiBuilder} from "../gql/GqlApiBuilder";
import {Handler, Router} from "express";
import fs from 'fs';
import path from 'path';
import extract from 'extract-zip';
import archiver from 'archiver';
import multer from 'multer';
import NcMetaIO, {META_TABLES} from "./NcMetaIO";
import {
  SqlClientFactory, Tele
} from 'nc-help'
import NcHelp from "../../utils/NcHelp";
import bodyParser from "body-parser";
import projectAcl from "../../utils/projectAcl";
import {v4 as uuidv4} from 'uuid';
import ProjectMgr from '../../sqlMgr/ProjectMgr';

import {nanoid} from 'nanoid';
import mimetypes, {mimeIcons} from "../../utils/mimeTypes";
import IStorageAdapter from "../../../interface/IStorageAdapter";
import IEmailAdapter from "../../../interface/IEmailAdapter";
import EmailFactory from "../plugins/adapters/email/EmailFactory";
import Twilio from "../plugins/adapters/twilio/Twilio";
import {NcConfigFactory} from "../../index";
import XcCache from "../plugins/adapters/cache/XcCache";
import axios from 'axios';
import isDocker from 'is-docker';
import slash from 'slash';


import RestAuthCtrl from "../rest/RestAuthCtrlEE";
import ExpressXcTsRoutesHm from "../../sqlMgr/code/routes/xc-ts/ExpressXcTsRoutesHm";
import ExpressXcTsRoutesBt from "../../sqlMgr/code/routes/xc-ts/ExpressXcTsRoutesBt";
import ExpressXcTsRoutes from "../../sqlMgr/code/routes/xc-ts/ExpressXcTsRoutes";
import NcPluginMgr from "../plugins/NcPluginMgr";

const XC_PLUGIN_DET = 'XC_PLUGIN_DET';


let packageInfo: any = {};
try {
  packageInfo = JSON.parse(fs.readFileSync('package.json', 'utf8'));
} catch (_e) {
}

export default class NcMetaMgr {
  public projectConfigs = {};

  public readonly pluginMgr: NcPluginMgr;

  public twilioInstance: Twilio;

  protected app: Noco;
  protected config: NcConfig;
  protected listener: (data) => Promise<any>;
  protected xcMeta: NcMetaIO;
  protected projectMgr: any;
  // @ts-ignore
  protected isEe: boolean = false;


  constructor(app: Noco, config: NcConfig, xcMeta: NcMetaIO) {
    this.app = app;
    this.config = config;
    this.xcMeta = xcMeta;
    this.projectMgr = ProjectMgr.make();
    this.pluginMgr = new NcPluginMgr(app, xcMeta);
  }

  public setConfig(config: NcConfig) {
    this.config = config;
  }

  public async initHandler(rootRouter: Router) {

    await this.pluginMgr?.init();

    await this.initStorage();
    await this.initEmail();
    await this.initTwilio();
    await this.initCache();
    this.eeVerify();

    const router = Router();
    for (const project of await this.xcMeta.projectList()) {
      const config = JSON.parse(project.config);
      this.projectConfigs[project.id] = config;
      this.projectMgr.getSqlMgr({...project, config, metaDb: this.xcMeta?.knex}).projectOpenByWeb(config);
    }


    // todo: acl
    router.get('/dl/:projectId/:dbAlias/:fileName', async (req, res) => {
      try {
        const type = mimetypes[path.extname(req.params.fileName).slice(1)] || 'text/plain';
        const img = await this.storageAdapter.fileRead(slash(path.join('nc', req.params.projectId, req.params.dbAlias, 'uploads', req.params.fileName)));
        res.writeHead(200, {'Content-Type': type});
        res.end(img, 'binary');
      } catch (e) {
        res.status(404).send('Not found')
      }
    });

    router.use(bodyParser.json({
      limit: process.env.NC_REQUEST_BODY_SIZE || 1024 * 1024
    }));

    if (!process.env.NC_SERVERLESS_TYPE && !this.config.try) {
      const upload = multer({dest: 'uploads/'})
      router.post(this.config.dashboardPath, upload.single('file'))
    }

    router.post(this.config.dashboardPath, (req, res, next) => this.handlePublicRequest(req, res, next));
    // @ts-ignore
    router.post(this.config.dashboardPath, async (req: any, res, next) => {
      if (req.file && req.body.json) {
        req.body = JSON.parse(req.body.json);
      }
      if (req?.session?.passport?.user?.isAuthorized) {
        if (req?.body?.project_id && !(await this.xcMeta.isUserHaveAccessToProject(req?.body?.project_id, req?.session?.passport?.user?.id))) {
          return res.status(403).json({msg: 'User doesn\'t have project access'})
        }

        if (req?.body?.api) {
          const roles = req?.session?.passport?.user?.roles;
          const isAllowed = roles && Object.entries(roles).some(([name, hasRole]) => {
            return hasRole && projectAcl[name] && (projectAcl[name] === '*' || projectAcl[name][req.body.api])
          })
          if (!isAllowed) {
            return res.status(403).json({msg: 'Not allowed'})
          }
        }
      }
      next();
    })
    router.post(this.config.dashboardPath,
      // handle request if it;s related to meta db
      (async (req: any, res, next): Promise<any> => {

        // auth to admin
        if (this.config.auth) {
          if (this.config.auth.jwt) {
            if (!(req?.session?.passport?.user?.roles?.creator || req?.session?.passport?.user?.roles?.editor
              || req?.session?.passport?.user?.roles?.viewer
              || req?.session?.passport?.user?.roles?.commenter
              || req?.session?.passport?.user?.roles?.user
            )) {
              return res.status(401).json({
                msg: 'Unauthorized access : xc-auth does not have admin permission'
              })
            }
          } else if (this.config?.auth?.masterKey) {
            if (req.headers['xc-master-key'] !== this.config.auth.masterKey.secret) {
              return res.status(401).json({
                msg: 'Unauthorized access : xc-admin header missing or not matching'
              })
            }
          }
        }

        if (req.file) {
          await this.handleRequestWithFile(req, res, next);
        } else {
          await this.handleRequest(req, res, next);
        }
      }) as Handler,
      // pass request to SqlMgr
      async (req: any, res) => {

        try {
          let output;
          if (req.file) {
            req.body = JSON.parse(req.body.json);
            output = await this.projectMgr.getSqlMgr({id: req.body.project_id}).handleRequestWithFile(req.body.api, req.body, req.file);
          } else {
            output = await this.projectMgr.getSqlMgr({id: req.body.project_id}).handleRequest(req.body.api, req.body);
          }

          if (this.listener) {
            await this.listener({
              req: req.body,
              res: output,
              user: req.user,
              ctx: {
                req, res
              }
            });
          }

          if (typeof output === 'object' && 'download' in output && 'filePath' in output && output.download === true) {
            return res.download(output.filePath);
          }
          res.json(output);
        } catch (e) {
          console.log(e)
          res.status(500).json({msg: e.message})
        }
      });


    router.get(`${this.config.dashboardPath}/auth/type`, async (_req, res): Promise<any> => {
      try {
        const projectHasDb = true // this.toolMgr.projectHasDb();
        if (this.config.auth) {
          if (this.config.auth.jwt) {

            let knex;
            knex = this.xcMeta.knex;

            let projectHasAdmin = false;
            projectHasAdmin = !!(await knex('xc_users').first())

            return res.json({
              authType: 'jwt',
              projectHasAdmin,
              firstUser: !projectHasAdmin,
              projectHasDb,
              type: this.config.type,
              env: this.config.workingEnv,
              googleAuthEnabled: !!(process.env.NC_GOOGLE_CLIENT_ID && process.env.NC_GOOGLE_CLIENT_SECRET),
              githubAuthEnabled: !!(process.env.NC_GITHUB_CLIENT_ID && process.env.NC_GITHUB_CLIENT_SECRET),
              oneClick: !!process.env.NC_ONE_CLICK,
              connectToExternalDB: !process.env.NC_CONNECT_TO_EXTERNAL_DB_DISABLED,
              version: packageInfo?.version
            })
          }
          if (this.config.auth.masterKey) {
            return res.json({
              authType: 'masterKey',
              // projectHasDb: this.toolMgr.projectHasDb(),
              type: this.config.type,
              env: this.config.workingEnv,
              oneClick: !!process.env.NC_ONE_CLICK
            })
          }
        }
        res.json({
          authType: 'none',
          projectHasDb,
          type: this.config.type,
          env: this.config.workingEnv,
          oneClick: !!process.env.NC_ONE_CLICK
        })
      } catch (e) {
        console.log(e)
        throw e;
      }
    });

    router.post('/auth/admin/verify', (req, res): any => {
      if (this.config.auth) {
        if (this.config.auth.masterKey && this.config.auth.masterKey.secret === req.body.secret) {
          return res.json(true)
        }
      }
      res.json(false)
    });

    router.post('/auth/xc-verify', (_req, res) => {
      this.isEe = true;
      res.json({msg: 'success'})
    })

    rootRouter.use(router)

  }

  public async handleRequestWithFile(req, res, next) {

    const [operation, args, file] = [req.body.api, req.body, req.file]
    let result;
    try {
      switch (operation) {

        case 'xcMetaTablesImportZipToLocalFsAndDb':
          result = await this.xcMetaTablesImportZipToLocalFsAndDb(args, file, req);
          break;


        case 'xcAttachmentUpload':
          result = await this.xcAttachmentUpload(req, args, file);
          break;

        default:
          next();
          break;
      }
    } catch (e) {
      return res.status(400).json({msg: e.message})
    }

    if (this.listener) {
      await this.listener({
        req: req.body,
        res: result,
        user: req.user,
        ctx: {
          req, res
        }
      });
    }

    return res.json(result);
  }


  // NOTE: updated
  public async xcMetaTablesReset(args) {


    if (!('dbAlias' in args)) {
      if (this.projectConfigs?.[args?.project_id]?.envs?.[args?.env]?.db) {
        for (const {meta: {dbAlias}} of this.projectConfigs[args.project_id].envs[args.env].db) {
          await this.xcMetaTablesReset({...args, dbAlias});
        }
      }
      return
    }

    const dbAlias = this.getDbAlias(args);
    for (const tn of META_TABLES[this.config.projectType.toLowerCase()]) {
      // await knexRef(tn).truncate();
      await this.xcMeta.metaDelete(args.project_id, dbAlias, tn, {});
    }

  }

  // NOTE: updated
  public async xcMetaTablesImportLocalFsToDb(args, req) {

    if (!('dbAlias' in args)) {
      for (const {meta: {dbAlias}} of this.projectConfigs[args.project_id].envs[args.env].db) {
        await this.xcMetaTablesImportLocalFsToDb({...args, dbAlias}, req);
      }
      return
    }

    try {
      const metaFolder = path.join(this.config.toolDir, 'nc', args.project_id, args.dbAlias, 'meta');
      const dbAlias = this.getDbAlias(args);
      const projectId = this.getProjectId(args);
      await this.xcMeta.startTransaction();

      await this.xcMetaTablesReset(args);

      for (const tn of META_TABLES[this.config.projectType.toLowerCase()]) {
        if (fs.existsSync(path.join(metaFolder, `${tn}.json`))) {
          const data = JSON.parse(fs.readFileSync(path.join(metaFolder, `${tn}.json`), 'utf8'));
          for (const row of data) {
            delete row.id;
            await this.xcMeta.metaInsert(projectId, dbAlias, tn, row)
          }
        }
      }
      this.xcMeta.commit();

      this.xcMeta.audit(projectId, dbAlias, 'nc_audit', {
        // created_at: (Knex as any).fn.now(),
        op_type: 'META',
        op_sub_type: 'IMPORT_FROM_FS',
        user: req.user.email,
        description: `imported ${projectId}(${dbAlias}) from local filesystem`,
        ip: req.clientIp
      })

    } catch (e) {
      console.log(e);
      this.xcMeta.rollback(e);
    }
  }

  // NOTE: xc-meta
  // Extract and import metadata and config from zip file
  public async xcMetaTablesImportZipToLocalFsAndDb(args, file, req) {
    try {
      await this.xcMetaTablesReset(args);
      let projectConfigPath;
      await extract(file.path, {
        dir: this.config.toolDir,
        onEntry(entry, _zipfile) {
          // extract xc_project.json file path
          if (entry.fileName?.endsWith('xc_project.json')) {
            projectConfigPath = entry.fileName;
          }
        }
      });
      // delete temporary upload file
      fs.unlinkSync(file.path);


      if (projectConfigPath) {
        // read project config and extract project id
        let projectConfig: any = fs.readFileSync(path.join(this.config?.toolDir, projectConfigPath), 'utf8');
        projectConfig = projectConfig && JSON.parse(projectConfig);
        const importProjectId = projectConfig?.id;

        // check project already exist
        if (await this.xcMeta.projectGetById(importProjectId)) {
          // todo:
        } else {
          // create the project if not found
          await this.xcMeta.knex('nc_projects').insert(projectConfig);
          projectConfig = JSON.parse((await this.xcMeta.projectGetById(importProjectId))?.config);

          // duplicated code from project create - see projectCreateByWeb
          await this.xcMeta.projectAddUser(importProjectId, req?.session?.passport?.user?.id, 'owner,creator');
          await this.projectMgr.getSqlMgr({
            ...projectConfig,
            metaDb: this.xcMeta?.knex
          }).projectOpenByWeb(projectConfig);
          this.projectConfigs[importProjectId] = projectConfig;

          args.freshImport = true;
        }
        args.project_id = importProjectId;
      }

      await this.xcMetaTablesImportLocalFsToDb(args, req);
      const projectId = this.getProjectId(args);
      this.xcMeta.audit(projectId, null, 'nc_audit', {
        op_type: 'META',
        op_sub_type: 'IMPORT_FROM_ZIP',
        user: req.user.email,
        description: `imported ${projectId} from zip file uploaded `, ip: req.clientIp
      })
    } catch (e) {
      throw e;
    }
  }


  // NOTE: updated
  public async xcMetaTablesExportDbToLocalFs(args, req) {

    if (!('dbAlias' in args)) {
      for (const {meta: {dbAlias}} of this.projectConfigs[args.project_id].envs[args.env].db) {
        await this.xcMetaTablesExportDbToLocalFs({...args, dbAlias}, req);
      }
    } else {

      try {
        const projectId = this.getProjectId(args)
        const metaFolder = path.join(this.config.toolDir, 'nc', args.project_id, args.dbAlias, 'meta');
        // const client = await this.projectGetSqlClient(args);
        const dbAlias = await this.getDbAlias(args);
        for (const tn of META_TABLES[this.config.projectType.toLowerCase()]) {
          // const metaData = await client.knex(tn).select();
          const metaData = await this.xcMeta.metaList(projectId, dbAlias, tn);
          fs.writeFileSync(path.join(metaFolder, `${tn}.json`), JSON.stringify(metaData, null, 2));

        }

        const projectMetaData = await this.xcMeta.projectGetById(projectId, true);
        fs.writeFileSync(path.join(metaFolder, `xc_project.json`), JSON.stringify(projectMetaData, null, 2));


        this.xcMeta.audit(projectId, dbAlias, 'nc_audit', {
          op_type: 'META',
          op_sub_type: 'EXPORT_TO_FS',
          user: req.user.email,
          description: `exported ${projectId}(${dbAlias}) to local filesystem `,
          ip: req.clientIp
        })

      } catch (e) {
        console.log(e)
      }
    }
  }

  // NOTE: updated
  public async xcMetaTablesExportDbToZip(args, req) {
    await this.xcMetaTablesExportDbToLocalFs(args, req);

    try {
      const filePath = path.join(this.config.toolDir, 'meta.zip');

      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(filePath);
        const archive = archiver('zip');

        output.on('close', () => {
          resolve(null);
          // console.log(archive.pointer() + ' total bytes');
          // console.log('archiver has been finalized and the output file descriptor has closed.');
        });

        archive.on('error', (err) => {
          reject(err);
        });

        archive.pipe(output);
        archive.directory(path.join(this.config.toolDir, 'nc', args.project_id), `xc/${args.project_id}`);
        // archive.file(path.join(this.config.toolDir, 'config.xc.json'), {name: 'config.xc.json'});
        archive.finalize();

      });


      this.xcMeta.audit(this.getProjectId(args), null, 'nc_audit', {
        op_type: 'META',
        op_sub_type: 'EXPORT_TO_ZIP',
        user: req.user.email,
        description: `exported ${this.getProjectId(args)} to zip file `, ip: req.clientIp
      })

      return {download: true, filePath}
    } catch (e) {
      throw e;
    }


  }


  // NOTE: updated
  public async xcRoutesPolicyGet(args) {
    const result = new Result();
    result.data.list = [];
    try {
      const dbAlias = await this.getDbAlias(args);
      result.data.list = (await this.xcMeta.metaList(args.project_id, dbAlias, 'nc_routes', {
        condition: {
          tn: args.args.tn
        }
      })).map(row => ({
        ...row,
        handler: JSON.parse(row.handler),
        acl: JSON.parse(row.acl)
      }))
    } catch (e) {
      console.log(e);
    }
    return result;
  }


  // NOTE: xc-meta
  public async xcRoutesPolicyAllGet(args) {
    const result = new Result();
    result.data.list = [];
    try {
      const client = await this.projectGetSqlClient(args);
      result.data.list = (await client.knex('nc_routes').select()).map(row => ({
        ...row,
        handler: JSON.parse(row.handler),
        acl: JSON.parse(row.acl)
      }))
    } catch (e) {
      console.log(e);
    }
    return result;
  }


  // NOTE: xc-meta
  public async xcResolverPolicyGetAll(args) {
    const result = new Result();
    result.data.list = [];
    try {
      const client = await this.projectGetSqlClient(args);
      result.data.list = (await client.knex('nc_resolvers')).map(row => ({
        ...row,
        acl: JSON.parse(row.acl)
      }))
    } catch (e) {
      console.log(e);
    }
    return result;
  }

  // NOTE: xc-meta
  public async xcRpcPolicyGetAll(args) {
    const result = new Result();
    result.data.list = [];
    try {
      const client = await this.projectGetSqlClient(args);
      result.data.list = (await client.knex('nc_rpc')).map(row => ({
        ...row,
        acl: JSON.parse(row.acl)
      }))
    } catch (e) {
      console.log(e);
    }
    return result;
  }

  // NOTE: xc-meta
  public async xcRoutesPolicyUpdate(args) {
    const client = await this.projectGetSqlClient(args);
    const trx = await client.knex.transaction();

    try {
      for (const row of args.data) {
        await trx('nc_routes').update({
          acl: JSON.stringify(row.acl)
        }).where({
          id: row.id
        })
      }
      trx.commit();
    } catch (e) {
      trx.rollback();
      throw e;
    }
  }


  // NOTE: xc-meta
  public async xcResolverPolicyUpdate(args) {
    const client = await this.projectGetSqlClient(args);
    const trx = await client.knex.transaction();

    try {
      for (const row of args.data) {
        await trx('nc_resolvers').update({
          acl: JSON.stringify(row.acl)
        }).where({
          id: row.id
        })
      }
      trx.commit();
    } catch (e) {
      trx.rollback();
      throw e;
    }
  }

  // NOTE: xc-meta
  public async xcRpcPolicyUpdate(args) {
    const client = await this.projectGetSqlClient(args);
    const trx = await client.knex.transaction();

    try {
      for (const row of args.data) {
        await trx('nc_rpc').update({
          acl: JSON.stringify(row.acl)
        }).where({
          id: row.id
        })
      }
      trx.commit();
    } catch (e) {
      trx.rollback();
      throw e;
    }
  }

  // NOTE: updated
  public async tableXcHooksDelete(args, req) {
    try {
      // args.args.data.url = args.args.data.url.trim();

      const dbAlias = await this.getDbAlias(args);
      const projectId = await this.getProjectId(args);

      if (args.args.id !== null && args.args.id !== undefined) {
        await this.xcMeta.metaDelete(projectId, dbAlias, 'nc_hooks', args.args.id);
      }

      this.xcMeta.audit(projectId, dbAlias, 'nc_audit', {
        op_type: 'WEBHOOKS',
        op_sub_type: 'DELETED',
        user: req.user.email,
        description: `deleted webhook ${args.args.title || args.args.id} of table ${args.args.tn} `,
        ip: req.clientIp
      })

      Tele.emit('evt', {evt_type: 'webhooks:deleted'})
    } catch (e) {
      throw e;
    }
  }

  // NOTE: updated
  public async tableXcHooksSet(args, req) {
    const projectId = this.getProjectId(args);
    try {
      // args.args.data.url = args.args.data.url.trim();

      const dbAlias = await this.getDbAlias(args);

      if (args.args.data.id !== null && args.args.data.id !== undefined) {
        await this.xcMeta.metaUpdate(projectId, dbAlias, 'nc_hooks', {
          ...args.args.data,
          active: true,
          notification: JSON.stringify(args.args.data.notification),
          condition: JSON.stringify(args.args.data.condition),
        }, args.args.data.id);
        this.xcMeta.audit(projectId, dbAlias, 'nc_audit', {
          op_type: 'WEBHOOKS',
          op_sub_type: 'UPDATED',
          user: req.user.email,
          description: `updated webhook ${args.args.data.title} - ${args.args.data.event} ${args.args.data.operation} - ${args.args.data.notification?.type} - of table ${args.args.tn} `,
          ip: req.clientIp
        })

        Tele.emit('evt', {evt_type: 'webhooks:updated'})
      } else {
        const res = await this.xcMeta.metaInsert(projectId, dbAlias, 'nc_hooks', {
          ...args.args.data,
          active: true,
          tn: args.args.tn,
          notification: JSON.stringify(args.args.data.notification),
          condition: JSON.stringify(args.args.data.condition),
        });
        this.xcMeta.audit(projectId, dbAlias, 'nc_audit', {
          op_type: 'WEBHOOKS',
          op_sub_type: 'INSERTED',
          user: req.user.email,
          description: `created webhook ${args.args.data.title} - ${args.args.data.event} ${args.args.data.operation} - ${args.args.data.notification?.type} - of table ${args.args.tn} `,
          ip: req.clientIp
        })
        Tele.emit('evt', {evt_type: 'webhooks:created'})
        return res;
      }

      /*      if (await this.xcMeta.metaGet(args.project_id, dbAlias, 'nc_hooks', {
              tn: args.args.tn,
              operation: args.args.data.operation,
              event: args.args.data.event
            })) {
              await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_hooks', {
                ...args.args.data,
                active: true
              }, {
                tn: args.args.tn,
                operation: args.args.data.operation,
                event: args.args.data.event
              })
            } else {
              await this.xcMeta.metaInsert(args.project_id, dbAlias, 'nc_hooks', {
                ...args.args.data,
                active: true,
                tn: args.args.tn
              })
            }*/
    } catch (e) {
      console.log(e);
      throw e
    }
  }


  // NOTE: xc-meta
  public async xcRoutesHandlerUpdate(args) {
    // const client = await this.projectGetSqlClient(args);
    const dbAlias = await this.getDbAlias(args);

    try {
      // await client.knex('nc_routes').update({
      //   functions: JSON.stringify(args.args.functions)
      // }).where({
      //   tn: args.args.tn,
      //   path: args.args.path,
      //   type: args.args.type
      // })
      await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_routes', {
        functions: JSON.stringify(args.args.functions)
      }, {
        tn: args.args.tn,
        path: args.args.path,
        type: args.args.type
      })
    } catch (e) {
      throw e;
    }
  }

  // NOTE: xc-meta
  public async xcRoutesMiddlewareUpdate(args) {
    const client = await this.projectGetSqlClient(args);

    try {
      await client.knex('nc_routes').update({
        functions: JSON.stringify(args.args.functions)
      }).where({
        tn: args.args.tn,
        title: args.args.title,
        handler_type: 2
      })
    } catch (e) {
      throw e;
    }
  }

  // NOTE: updated
  public async xcRpcHandlerUpdate(args) {

    try {
      const dbAlias = this.getDbAlias(args);
      await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_rpc', {
        functions: JSON.stringify(args.args.functions)
      }, {
        tn: args.args.tn,
        service: args.args.service,
      })
    } catch (e) {
      throw e;
    }


  }

  // NOTE: xc-meta
  public async rolesGet(args) {
    const client = await this.projectGetSqlClient(args);

    try {
      return await client.knex('nc_roles').select()
    } catch (e) {
      throw e;
    }
  }

  // NOTE: xc-meta
  public async rolesSaveOrUpdate(args) {

    let aclTable;

    if (this.isProjectGraphql()) {
      aclTable = 'nc_resolvers';
    } else if (this.isProjectRest()) {
      aclTable = 'nc_routes';
    } else if (this.isProjectGrpc()) {
      aclTable = 'nc_rpc';
    }

    // todo: update within all

    const client = await this.projectGetSqlClient(args);
    let trx;
    try {
      // todo: optimize transaction
      trx = await client.knex.transaction();

      for (const role of args.args) {

        if (role.id) {
          const oldRole = await trx('nc_roles').where({
            id: role.id
          }).first();
          if (this.isProjectGraphql()) {
            const aclRows = await trx(aclTable).select();
            for (const aclRow of aclRows) {
              try {
                if (aclRow.acl) {
                  const acl = JSON.parse(aclRow.acl);
                  acl[role.title] = acl[oldRole.title];
                  delete acl[oldRole.title];
                  await trx(aclTable).update({
                    acl: JSON.stringify(acl)
                  }).where({
                    id: aclRow.id
                  });
                }
              } catch (e) {
                console.log(e);
              }
            }

          }
          if (oldRole.title !== role.title || oldRole.description !== role.description) {
            await trx('nc_roles').update({
              ...role
            }).where({
              id: role.id
            });
          }

        } else {

          if ((await trx('nc_roles').where({title: role.title})).length) {
            throw new Error(`Role name '${role.title}' already exist`)
          }

          await trx('nc_roles').insert(role)
          const aclRows = await trx(aclTable).select();
          for (const aclRow of aclRows) {
            try {
              if (aclRow.acl) {
                const acl = JSON.parse(aclRow.acl);
                acl[role.title] = true;
                await trx(aclTable).update({
                  acl: JSON.stringify(acl)
                }).where({
                  id: aclRow.id
                });
              }
            } catch (e) {
              // throw e;
              console.log(e);
            }
          }
        }

      }
      await trx.commit();

    } catch (e) {
      if (trx) {
        trx.rollback(e);
      }
      throw e;
    }
  }

  public setListener(listener: (data) => Promise<any>) {
    this.listener = listener;
  }


  public async xcAttachmentUploadPrivate(req, args, file) {
    try {
      const fileName = `${nanoid(6)}${path.extname(file.originalname)}`
      const destPath = path.join('nc', this.getProjectId(args), this.getDbAlias(args), 'uploads');

      await this.storageAdapter.fileCreate(slash(path.join(destPath, fileName)), file);

      return {
        url: `${req.ncSiteUrl}/dl/${this.getProjectId(args)}/${this.getDbAlias(args)}/${fileName}`,
        title: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        icon: mimeIcons[path.extname(file.originalname).slice(1)] || undefined
      };

    } catch (e) {
      throw e;
    }
  }

  public async xcAttachmentUpload(req, args, file) {
    try {
      const fileName = `${nanoid(6)}${path.extname(file.originalname)}`
      let destPath;
      if (args?.args?.public) {
        destPath = path.join('nc', 'public', 'files', 'uploads');
      } else {
        destPath = path.join('nc', this.getProjectId(args), this.getDbAlias(args), 'uploads');
      }
      let url = await this.storageAdapter.fileCreate(slash(path.join(destPath, fileName)), file);
      if (!url) {
        if (args?.args?.public) {
          url = `${req.ncSiteUrl}/dl/public/files/${fileName}`;
        } else {
          url = `${req.ncSiteUrl}/dl/${this.getProjectId(args)}/${this.getDbAlias(args)}/${fileName}`;
        }
      }
      return {
        url,
        title: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        icon: mimeIcons[path.extname(file.originalname).slice(1)] || undefined
      };

    } catch (e) {
      throw e;
    } finally {
      Tele.emit('evt', {evt_type: 'image:uploaded'})
    }
  }

  protected async initStorage(_overwrite = false): Promise<void> {
    //
    // const activeStorage = await this.xcMeta.metaGet(null, null, 'nc_plugins', {
    //   active: true,
    //   category: 'Storage'
    // });
    //
    // this.storageAdapter = StorageFactory.create(activeStorage, overwrite);
    // await this.storageAdapter?.init();
  }

  protected async initEmail(_overwrite = false): Promise<void> {

    // const activeStorage = await this.xcMeta.metaGet(null, null, 'nc_plugins', {
    //   active: true,
    //   category: 'Email'
    // });
    //
    // this.emailAdapter = EmailFactory.create(activeStorage, overwrite);
    // await this.emailAdapter?.init();
  }

  protected async initTwilio(overwrite = false): Promise<void> {

    const activeStorage = await this.xcMeta.metaGet(null, null, 'nc_plugins', {
      active: true,
      category: 'Twilio'
    });

    this.twilioInstance = Twilio.create(activeStorage, overwrite);
    await this.twilioInstance?.init();
  }

  protected async initCache(overwrite = false): Promise<void> {

    const activeCache = await this.xcMeta.metaGet(null, null, 'nc_plugins', {
      active: true,
      category: 'Cache'
    });

    XcCache.init(activeCache, overwrite);
  }

  protected async handlePublicRequest(req, res, next) {
    const args = req.body;
    let result;
    try {
      switch (args.api) {
        case 'displaySharedViewLink':
          result = await this.displaySharedViewLink(args);
          break;
        case 'getSharedViewData':
          result = await this.getSharedViewData(req, args);
          break;

        default:
          return next();

      }
    } catch (e) {
      return next(e);
    }
    res.json(result);
  }

  protected async handleRequest(req, res, next) {
    try {
      const args = req.body;
      let result;

      switch (args.api) {

        case 'xcPluginDemoDefaults':
          result = await this.xcPluginDemoDefaults(args);
          break;
        case 'xcApiTokenList':
          result = await this.xcApiTokenList(args);
          break;
        case 'xcAuditList':
          result = await this.xcAuditList(args);
          break;
        case 'xcModelRowAuditAndCommentList':
          result = await this.xcModelRowAuditAndCommentList(args);
          break;
        case 'xcAuditCommentInsert':
          result = await this.xcAuditCommentInsert(args, req);
          break;
        case 'xcAuditCreate':
          result = await this.xcAuditCreate(args, req);
          break;
        case 'xcAuditModelCommentsCount':
          result = await this.xcAuditModelCommentsCount(args);
          break;
        case 'xcApiTokenCreate':
          result = await this.xcApiTokenCreate(args);
          break;
        case 'xcApiTokenUpdate':
          result = await this.xcApiTokenUpdate(args);
          break;
        case 'xcApiTokenDelete':
          result = await this.xcApiTokenDelete(args);
          break;

        case 'xcVirtualTableCreate':
          result = await this.xcVirtualTableCreate(args, req);
          break;
        case 'xcVirtualTableRename':
          result = await this.xcVirtualTableRename(args, req);
          break;
        case 'xcVirtualTableUpdate':
          result = await this.xcVirtualTableUpdate(args);
          break;
        case 'ncProjectInfo':
          result = await this.ncProjectInfo(args);
          break;
        case 'xcVirtualTableDelete':
          result = await this.xcVirtualTableDelete(args, req);
          break;
        case 'xcVirtualTableList':
          result = await this.xcVirtualTableList(args);
          break;

        case 'xcVersionLetters':
          result = this.xcVersionLetters(args);
          break;

        case 'xcPluginList':
          result = await this.xcPluginList(args);
          break;
        case 'xcPluginRead':
          result = await this.xcPluginRead(args);
          break;
        case 'xcPluginTest':
          result = await this.xcPluginTest(req, args);
          break;
        case 'xcPluginCreate':
          result = await this.xcPluginCreate(args);
          break;
        case 'xcPluginDelete':
          result = await this.xcPluginDelete(args);
          break;
        case 'xcPluginSet':
          result = await this.xcPluginSet(args);
          break;

        case 'xcVisibilityMetaGet':
          result = await this.xcVisibilityMetaGet(args);
          break;

        case 'xcVisibilityMetaSet':
          result = await this.xcVisibilityMetaSet(args);
          break;

        case 'tableList':
          result = await this.xcTableList(req, args);
          break;

        case 'columnList':
          result = await this.xcColumnList(args);
          break;

        case 'viewList':
          result = await this.xcViewList(req, args);
          break;

        case 'functionList':
          result = await this.xcFunctionList(req, args);
          break;

        case 'procedureList':
          result = await this.xcProcedureList(req, args);
          break;

        case 'xcAuthHookGet':
          result = await this.xcAuthHookGet(args);
          break;

        case 'xcAuthHookSet':
          result = await this.xcAuthHookSet(args);
          break;

        case 'createSharedViewLink':
          result = await this.createSharedViewLink(req, args);
          break;

        case 'updateSharedViewLinkPassword':
          result = await this.updateSharedViewLinkPassword(args);
          break;
        case 'deleteSharedViewLink':
          result = await this.deleteSharedViewLink(args);
          break;
        case 'listSharedViewLinks':
          result = await this.listSharedViewLinks(args);
          break;


        case 'testConnection':
          result = await SqlClientFactory.create(args.args).testConnection();
          break;
        case 'xcProjectGetConfig':
          result = await this.xcMeta.projectGetById(this.getProjectId(args));
          break;

        case 'projectCreateByWeb':
          if (process.env.NC_CONNECT_TO_EXTERNAL_DB_DISABLED) {
            throw new Error('Creating new project with external Database not allowed')
          }
          result = await this.xcMeta.projectCreate(args.args.project.title, args.args.projectJson);
          await this.xcMeta.projectAddUser(result.id, req?.session?.passport?.user?.id, 'owner,creator');
          await this.projectMgr.getSqlMgr({
            ...result,
            config: args.args.projectJson,
            metaDb: this.xcMeta?.knex
          }).projectOpenByWeb(args.args.projectJson);
          this.projectConfigs[result.id] = args.args.projectJson;

          this.xcMeta.audit(result.id, null, 'nc_audit', {
            op_type: 'PROJECT',
            op_sub_type: 'CREATED',
            user: req.user.email,
            description: `created project ${args.args.projectJson.title}(${result.id}) `,
            ip: req.clientIp
          })

          Tele.emit('evt', {evt_type: 'project:created'})
          break;

        case 'projectUpdateByWeb':
          await this.xcMeta.projectUpdate(this.getProjectId(args), args.args.projectJson)
          Tele.emit('evt', {evt_type: 'project:updated'})
          break;
        case 'projectCreateByOneClick': {
          const config = NcConfigFactory.makeProjectConfigFromUrl(process.env.NC_DB, args.args.projectType);
          config.title = args.args.title;
          config.projectType = args.args.projectType;
          result = await this.xcMeta.projectCreate(config.title, config);
          await this.xcMeta.projectAddUser(result.id, req?.session?.passport?.user?.id, 'owner,creator');
          await this.projectMgr.getSqlMgr({
            ...result,
            config,
            metaDb: this.xcMeta?.knex
          }).projectOpenByWeb(config);
          this.projectConfigs[result.id] = config;

          this.xcMeta.audit(result.id, null, 'nc_audit', {
            op_type: 'PROJECT',
            op_sub_type: 'CREATED',
            user: req.user.email,
            description: `created project ${config.title}(${result.id}) `,
            ip: req.clientIp
          })
          Tele.emit('evt', {evt_type: 'project:created', oneClick: true})
        }
          break;
        case 'projectCreateByWebWithXCDB': {
          const config = NcConfigFactory.makeProjectConfigFromConnection(this.config?.meta?.db, args.args.projectType);
          config.title = args.args.title;
          config.projectType = args.args.projectType;

          const metaProjectsCount = await this.xcMeta.metaGet(null, null, 'nc_store', {
            key: 'NC_PROJECT_COUNT'
          });
          // todo: populate unique prefix dynamically
          config.prefix = `xb${Object.keys(this.projectConfigs).length}__`;
          if (metaProjectsCount) {
            // todo: populate unique prefix dynamically
            config.prefix = `xa${(+metaProjectsCount.value || 0) + 1}__`;
          }


          result = await this.xcMeta.projectCreate(config.title, config);
          await this.xcMeta.projectAddUser(result.id, req?.session?.passport?.user?.id, 'owner,creator');
          await this.projectMgr.getSqlMgr({
            ...result,
            config,
            metaDb: this.xcMeta?.knex
          }).projectOpenByWeb(config);
          this.projectConfigs[result.id] = config;
          this.xcMeta.metaUpdate(null, null, 'nc_store', {
            value: ((metaProjectsCount && +metaProjectsCount.value) || 0) + 1
          }, {key: 'NC_PROJECT_COUNT'})

          this.xcMeta.audit(result?.id, null, 'nc_audit', {
            op_type: 'PROJECT',
            op_sub_type: 'CREATED',
            user: req.user.email,
            description: `created project ${config.title}(${result.id}) within xcdb `,
            ip: req.clientIp
          })

          Tele.emit('evt', {evt_type: 'project:created', xcdb: true})
          break;
        }
        case 'projectList':
          result = await this.xcMeta.userProjectList(req?.session?.passport?.user?.id);
          result.forEach(p => {
            p.projectType = JSON.parse(p.config)?.projectType;
            delete p.config
          })
          break;

        case 'projectStop':
        case 'projectDelete':
        case 'projectRestart':
        case 'projectStart':

          Tele.emit('evt', {evt_type: 'project:' + args.api})
          result = null;
          break;

        case 'tableXcHooksGet':
          result = await this.tableXcHooksGet(args);
          break;
        case 'tableXcHooksList':
          result = await this.tableXcHooksList(args);
          break;

        case 'tableXcHooksSet':
          result = await this.tableXcHooksSet(args, req);
          break;


        case 'tableXcHooksDelete':
          result = await this.tableXcHooksDelete(args, req);
          break;

        case 'defaultRestHandlerCodeGet':
          result = await this.defaultRestHandlerCodeGet(args);
          break;

        case 'xcMetaTablesExportDbToLocalFs':
          result = await this.xcMetaTablesExportDbToLocalFs(args, req);
          break;

        case 'xcMetaTablesImportLocalFsToDb':
          result = await this.xcMetaTablesImportLocalFsToDb(args, req);
          break;

        case 'xcMetaTablesExportDbToZip':
          result = await this.xcMetaTablesExportDbToZip(args, req);
          break;

        case 'xcMetaTablesReset':
          result = await this.xcMetaTablesReset(args);
          break;

        case 'xcRoutesHandlerUpdate':
          result = await this.xcRoutesHandlerUpdate(args);
          break;

        case 'xcRoutesMiddlewareUpdate':
          result = await this.xcRoutesMiddlewareUpdate(args);
          break;

        case 'xcResolverHandlerUpdate':
          result = await this.xcResolverHandlerUpdate(args);
          break;

        case 'xcResolverMiddlewareUpdate':
          result = await this.xcResolverMiddlewareUpdate(args);
          break;

        case 'xcRpcHandlerUpdate':
          result = await this.xcRpcHandlerUpdate(args);
          break;

        case 'xcRpcPolicyGet':
          result = await this.xcRpcPolicyGet(args);
          break;

        case 'xcRoutesPolicyGet':
          result = await this.xcRoutesPolicyGet(args);
          break;


        case 'rolesGet':
          result = await this.rolesGet(args);
          break;

        case 'xcResolverPolicyGet':
          result = await this.xcResolverPolicyGet(args);
          break;

        case 'rolesSaveOrUpdate':
          result = await this.rolesSaveOrUpdate(args);
          break;

        case 'rolesDelete':
          result = await this.rolesDelete(args);
          break;

        case 'tableXcModelGet':
          result = await this.tableXcModelGet(req, args);
          break;

        case 'xcModelSet':
          result = await this.xcModelSet(args);
          break;

        case 'xcRelationsGet':
          result = await this.xcRelationsGet(args);
          break;

        case 'xcRelationsSet':
          result = await this.xcRelationsSet(args);
          break;

        case 'xcModelSchemaSet':
          result = await this.xcModelSchemaSet(args);
          break;

        case 'xcModelMessagesAndServicesSet':
          result = await this.xcModelMessagesAndServicesSet(args);
          break;

        case 'xcModelSwaggerDocSet':
          result = await this.xcModelSwaggerDocSet(args);
          break;

        case 'xcModelsEnable':
          result = await this.xcModelsEnable(args);
          break;


        case 'xcViewModelsEnable':
          result = await this.xcViewModelsEnable(args);
          break;

        case 'xcTableModelsEnable':
          result = await this.xcTableModelsEnable(args);
          break;

        case 'xcFunctionModelsEnable':
          result = await this.xcFunctionModelsEnable(args);
          break;

        case 'xcProcedureModelsEnable':
          result = await this.xcProcedureModelsEnable(args);
          break;

        case 'xcModelsList':
          result = await this.xcModelsList(args);
          break;

        case 'xcViewModelsList':
          result = await this.xcViewModelsList(args);
          break;

        case 'xcProcedureModelsList':
          result = await this.xcProcedureModelsList(args);
          break;

        case 'xcFunctionModelsList':
          result = await this.xcFunctionModelsList(args);
          break;

        case 'xcTableModelsList':
          result = await this.xcTableModelsList(args);
          break;

        case 'xcCronList':
          result = await this.xcCronList(args);
          break;


        case 'xcCronSave':
          result = await this.xcCronSave(args);
          break;

        case 'cronDelete':
          result = await this.cronDelete(args);
          break;

        case 'xcAclGet':
          result = await this.xcAclGet(args);
          break;

        case 'xcAclSave':
          result = await this.xcAclSave(args, req);
          break;

        case 'xcAclAggregatedGet':
          result = await this.xcAclAggregatedGet(args);
          break;

        case 'xcAclAggregatedSave':
          result = await this.xcAclAggregatedSave(args);
          break;

        case 'xcDebugGet':
          result = await this.xcDebugGet(args);
          break;

        case 'xcDebugSet':
          result = await this.xcDebugSet(args);
          break;

        case 'xcVirtualRelationCreate':
          result = await this.xcVirtualRelationCreate(args, req);
          break;

        case 'xcM2MRelationCreate':
          result = await this.xcM2MRelationCreate(args, req);
          break;

        case 'xcRelationColumnDelete':
          result = await this.xcRelationColumnDelete(args, req);
          break;

        case 'xcVirtualRelationDelete':
          result = await this.xcVirtualRelationDelete(args, req);
          break;

        case 'xcRelationList':
          result = await this.xcRelationList(args);
          break;

        case 'tableMetaCreate':
        case 'tableMetaDelete':
        case 'tableMetaRecreate':
        case 'viewMetaCreate':
        case 'viewMetaDelete':
        case 'viewMetaRecreate':
        case 'procedureMetaCreate':
        case 'procedureMetaDelete':
        case 'procedureMetaRecreate':
        case 'functionMetaCreate':
        case 'functionMetaDelete':
        case 'functionMetaRecreate':
          result = {msg: 'success'};
          break;

        default:
          return next();
      }

      if (this.listener) {
        await this.listener({
          user: req.user,
          req: req.body,
          res: result,
          ctx: {
            req, res
          }
        });
      }

      if (result && typeof result === 'object' && 'download' in result && 'filePath' in result && result.download === true) {
        return res.download(result.filePath);
      }


      res.json(result);

    } catch (e) {
      console.log(e);
      if (e instanceof XCEeError) {
        res.status(402).json({
          msg: e.message
        })
      } else {
        res.status(400).json({
          msg: e.message
        })
      }
    }
  }


  protected async xcDebugSet(args) {

    NcHelp.enableOrDisableDebugLog(args.args);

    return this.xcMeta.metaUpdate(args.project_id, '', 'nc_store', {
      value: JSON.stringify(args.args)
    }, {
      key: 'NC_DEBUG'
    })
  }


  protected async xcDebugGet(_args) {
    return this.xcMeta.metaGet('', '', 'nc_store', {
      key: 'NC_DEBUG'
    })
  }

  // NOTE: updated
  protected async xcAclGet(args): Promise<any> {
    try {
      // const client = await this.projectGetSqlClient(args);
      // return await client.knex('nc_acl').where({
      //   tn: args.args.tn || args.args.name
      // }).first();
      const dbAlias = await this.getDbAlias(args);
      return await this.xcMeta.metaGet(args.project_id, dbAlias, 'nc_acl', {
        tn: args.args.tn || args.args.name
      });
    } catch (e) {
      throw(e);
    }
  }


  // NOTE: updated
  protected async xcAclAggregatedGet(args): Promise<any> {
    const ops = ['create', 'read', 'update', 'delete'];
    const res = {}
    try {

      const roles = await this.xcMeta.metaList('', '', 'nc_roles');

      for (const {title} of roles) {
        res[title] = {};
        ops.forEach(op => res[title][op] = false)
      }


      for (const dbAlias of this.getDbAliasList(args.project_id)) {
        const aclRows = await this.xcMeta.metaList(args.project_id, dbAlias, 'nc_acl');


        for (const aclRow of aclRows) {
          const acl = JSON.parse(aclRow.acl);
          for (const role of Object.keys(acl)) {
            res[role] = res[role] || {};
            if (typeof acl[role] === 'object') {
              for (const op of ops) {
                if (!res[role][op]) {
                  if (acl[role][op] && typeof acl[role][op] === 'object' && acl[role][op].columns) {
                    res[role][op] = Object.values(acl[role][op].columns).some(v => v);
                  } else {
                    res[role][op] = acl[role][op]
                  }
                }
              }
            } else {
              for (const op of ops) {
                res[role][op] = res[role][op] || acl[role];
              }
            }
          }
        }
      }
    } catch (e) {
      throw(e);
    }
    return res;
  }

  // NOTE: updated
  protected async xcAclSave(args, req): Promise<any> {
    // if (!this.isEe) {
    for (const acl of Object.values(args.args.acl)) {
      for (const colLevelAcl of Object.values(acl)) {
        if (typeof colLevelAcl === 'boolean') {
          continue;
        }
        const allowed = Object.values(colLevelAcl.columns);
        if (!allowed.every(v => v === allowed[0])) {
          throw new XCEeError('Please upgrade')
        }
      }
    }
    // }


    try {
      const dbAlias = await this.getDbAlias(args);
      const projectId = await this.getProjectId(args);
      const res = await this.xcMeta.metaUpdate(projectId, dbAlias, 'nc_acl', {
        acl: JSON.stringify(args.args.acl)
      }, {
        tn: args.args.tn || args.args.name
      });

      this.app.ncMeta.audit(projectId, dbAlias, 'nc_audit', {
        op_type: 'TABLE_ACL',
        op_sub_type: 'UPDATED',
        user: req.user.email,
        description: `updated table ${args.args.tn || args.args.name} acl `, ip: req.clientIp
      });


      Tele.emit('evt', {evt_type: 'acl:updated'})

      return res;

    } catch (e) {
      throw(e);
    }
  }


  // NOTE: updated
  protected async xcAclAggregatedSave(args): Promise<any> {
    try {
      for (const dbAlias of this.getDbAliasList(args.project_id)) {
        await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_acl', {acl: JSON.stringify(args.args)}, {})
      }
    } catch (e) {
      console.log(e);
    }
  }


  // NOTE: updated
  protected async xcResolverPolicyGet(args): Promise<any> {
    const result = new Result();
    result.data.list = [];
    try {

      const dbAlias = await this.getDbAlias(args);
      result.data.list = (await this.xcMeta.metaList(args.project_id, dbAlias, 'nc_resolvers', {
        condition: {
          title: args.args.tn
        }
      })).map(row => ({
        ...row,
        acl: JSON.parse(row.acl)
      }))
    } catch (e) {
      console.log(e);
    }
    return result;
  }

  // NOTE: updated
  // @ts-ignore
  protected async xcRpcPolicyGet(args): Promise<any> {
    const result = new Result();
    result.data.list = [];
    try {
      const dbAlias = await this.getDbAlias(args);
      result.data.list = (await this.xcMeta.metaList(args.project_id, dbAlias, 'nc_rpc', {
        condition: {
          tn: args.args.tn
        }
      })).map(row => ({
        ...row,
        acl: JSON.parse(row.acl)
      }))
    } catch (e) {
      console.log(e);
    }
    return result;
  }

  // NOTE: updated
  protected async tableXcHooksGet(args): Promise<any> {
    const result = new Result();
    result.data.list = [];
    try {
      const dbAlias = await this.getDbAlias(args);
      result.data.list = await this.xcMeta.metaList(args.project_id, dbAlias, 'nc_hooks', {
        condition: {
          tn: args.args.tn,
          operation: args.args.data.operation,
          event: args.args.data.event
        }
      })
    } catch (e) {
      console.log(e);
    }
    return result;
  }

  // NOTE: updated
  protected async tableXcHooksList(args): Promise<any> {
    const result = new Result();
    result.data.list = [];
    try {
      const dbAlias = await this.getDbAlias(args);
      result.data.list = await this.xcMeta.metaList(args.project_id, dbAlias, 'nc_hooks', {
        condition: {
          tn: args.args.tn
        }
      })
    } catch (e) {
      console.log(e);
    }
    return result;
  }

  // NOTE: updated
  protected async tableXcModelGet(req, args): Promise<any> {

    console.time('tableXcModelGet')

    const roles = req.session?.passport?.user?.roles;
    const dbAlias = await this.getDbAlias(args);

    let meta = this.cacheModelGet(args.project_id, dbAlias, 'table', args.args.tn);

    if (!meta) {
      meta = await this.xcMeta.metaGet(args.project_id, dbAlias, 'nc_models', {
        title: args.args.tn,
        // type: 'table'
      }, [
        'alias',
        'meta',
        'parent_model_title',
        'title',
        'query_params'
      ]);
      this.cacheModelSet(args.project_id, dbAlias, 'table', args.args.tn, meta);
    }


    if (req?.session?.passport?.user?.roles?.creator) {
      return meta;
    }

    const disabledData = await this.xcMeta.metaList(this.getProjectId(args), this.getDbAlias(args), 'nc_disabled_models_for_role', {
      xcCondition: {
        _or: [{
          relation_type: {
            eq: 'hm'
          },
          rtn: {
            eq: args.args.tn
          }
        }, {
          relation_type: {
            eq: 'bt'
          },
          tn: {
            eq: args.args.tn
          }
        }]
      }
    });


    const groupedDisabledData = disabledData.reduce((o, d) => {
      const key = [
        d.tn,
        d.relation_type,
        d.rtn,
        d.cn,
        d.rcn,
        d.role].join('||');

      o[key] = d.disabled;

      return o;
    }, {})

    const parsedTableMeta = JSON.parse(meta.meta);

    if (parsedTableMeta?.belongsTo) {
      parsedTableMeta.belongsTo = parsedTableMeta.belongsTo.filter(bt => {
        const key = [
          bt.tn,
          'bt',
          bt.rtn,
          bt.cn,
          bt.rcn
        ].join('||');
        return Object.keys(roles).some(role => roles[role] && !groupedDisabledData[`${key}||${role}`])
      })
    }
    if (parsedTableMeta?.hasMany) {
      parsedTableMeta.hasMany = parsedTableMeta.hasMany.filter(hm => {
        const key = [
          hm.tn,
          'hm',
          hm.rtn,
          hm.cn,
          hm.rcn
        ].join('||');
        return Object.keys(roles).some(role => roles[role] && !groupedDisabledData[`${key}||${role}`])
      })
    }

    meta.meta = JSON.stringify(parsedTableMeta);

    console.timeEnd('tableXcModelGet')
    return meta;
  }

  // NOTE: updated
  protected async xcModelSet(args): Promise<any> {
    const dbAlias = await this.getDbAlias(args);
    this.cacheModelDel(args.project_id, dbAlias, 'table', args.args.tn);
    return this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_models', {
      meta: JSON.stringify(args.args.meta)
    }, {
      title: args.args.tn
    });
  }

  // NOTE: updated
  protected async xcRelationsGet(args): Promise<any> {
    const dbAlias = await this.getDbAlias(args);
    const metas = await this.xcMeta.metaList(args.project_id, dbAlias, 'nc_models', {
      condition: {
        type: 'table'
      }
    });
    const list = [];
    for (const meta of metas) {
      const metaObj = JSON.parse(meta.meta);
      list.push(...metaObj.hasMany.map(rel => {
        rel.relationType = 'hm';
        rel.edited = false;
        return rel;
      }))
      list.push(...metaObj.belongsTo.map(rel => {
        rel.relationType = 'bt';
        rel.edited = false;
        return rel;
      }))
    }
    return list;
  }

  // NOTE: updated
  protected async xcRelationsSet(_args): Promise<any> {
    XCEeError.throw()
  }

  // NOTE: xc-meta
  protected async xcModelsEnable(args): Promise<any> {
    const dbAlias = await this.getDbAlias(args);
    await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_models', {
      enabled: true
    }, null, {'title': {in: args.args}});

    await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_models', {
      enabled: false
    }, null, {'title': {nin: args.args}});
  }

  // NOTE: updated
  protected async xcViewModelsEnable(args): Promise<any> {
    const dbAlias = await this.getDbAlias(args);
    await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_models', {
      enabled: true
    }, null, {
      'title': {
        in: args.args
      },
      'type': {
        eq: 'view'
      }
    });

    await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_models', {
      enabled: false
    }, null, {
      'title': {
        nin: args.args
      },
      'type': {
        eq: 'view'
      }
    });

  }

  // NOTE: updated
  protected async xcTableModelsEnable(_args): Promise<any> {
    XCEeError.throw()
  }

  // NOTE: xc-meta
  protected async xcProcedureModelsEnable(args): Promise<any> {

    const dbAlias = await this.getDbAlias(args);

    await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_models', {
      enabled: true
    }, null, {
      'title': {in: args.args},
      'type': {eq: 'procedure'}
    });
    await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_models', {
      enabled: false
    }, null, {
      'title': {nin: args.args},
      'type': {eq: 'procedure'}
    });

  }

  // NOTE: updated
  protected async xcFunctionModelsEnable(args): Promise<any> {

    const dbAlias = await this.getDbAlias(args);
    await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_models', {
      enabled: true
    }, null, {
      'title': {in: args.args},
      'type': {eq: 'function'}
    });

    await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_models', {
      enabled: false
    }, null, {
      'title': {nin: args.args},
      'type': {eq: 'function'}
    });
  }

  // NOTE: xc-meta
  protected async xcModelsList(args): Promise<any> {
    const dbAlias = await this.getDbAlias(args);
    return this.xcMeta.metaList(args.project_id, dbAlias, 'nc_models', {
      condition: {
        'title': 'enabled'
      }
    });
  }

  // NOTE: updated
  protected async xcTableModelsList(args): Promise<any> {
    const dbAlias = this.getDbAlias(args);
    return this.xcMeta.metaList(args.project_id, dbAlias, 'nc_models', {
      condition: {
        'type': 'table'
      }
    });
  }

  // NOTE: updated
  protected async xcViewModelsList(args): Promise<any> {
    const dbAlias = this.getDbAlias(args);
    return this.xcMeta.metaList(args.project_id, dbAlias, 'nc_models', {
      condition: {
        'type': 'view'
      }
    });
  }

  // NOTE: updated
  protected async xcProcedureModelsList(args): Promise<any> {
    const dbAlias = await this.getDbAlias(args);
    return this.xcMeta.metaList(args.project_id, dbAlias, 'nc_models', {condition: {'type': 'procedure'}});
  }

  // NOTE: updated
  protected async xcFunctionModelsList(args): Promise<any> {
    const dbAlias = await this.getDbAlias(args);
    return this.xcMeta.metaList(args.project_id, dbAlias, 'nc_models', {condition: {'type': 'function'}});
  }

  // NOTE: updated
  protected async xcCronList(args): Promise<any> {
    // const client = await this.projectGetSqlClient(args);
    // return client.knex('nc_cron').select();
    const dbAlias = await this.getDbAlias(args);
    return this.xcMeta.metaList(args.project_id, dbAlias, 'nc_cron');
  }

  // NOTE: updated
  protected async xcCronSave(args): Promise<any> {
    const {id, ...rest} = args.args;
    const dbAlias = await this.getDbAlias(args);
    if (id) {
      return this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_cron', rest, {id});
    } else {
      return this.xcMeta.metaInsert(args.project_id, dbAlias, 'nc_cron', rest);
    }
  }

  // NOTE: updated
  protected async cronDelete(args): Promise<any> {
    const dbAlias = await this.getDbAlias(args);
    return this.xcMeta.metaDelete(args.project_id, dbAlias, 'nc_cron', args.args.id);
  }

  // NOTE: updated
  protected async xcModelSchemaSet(args): Promise<any> {
    const dbAlias = await this.getDbAlias(args);
    return this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_models', {
      schema: args.args.schema
    }, {
      title: args.args.tn
    });
  }

  protected async xcModelMessagesAndServicesSet(args): Promise<any> {
    const dbAlias = await this.getDbAlias(args);
    return this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_models', {
      messages: args.args.messages,
      services: args.args.services
    }, {
      title: args.args.tn
    });
  }


  protected async xcModelSwaggerDocSet(args): Promise<any> {
    const dbAlias = await this.getDbAlias(args);
    return this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_models', {
      schema: JSON.stringify(args.args.swaggerDoc)
    }, {
      title: args.args.tn
    });
  }


  // NOTE: xc-meta
  protected async rolesDelete(args): Promise<any> {
    const client = await this.projectGetSqlClient(args);

    let aclTable;

    if (this.isProjectGraphql()) {
      aclTable = 'nc_resolvers';
    } else if (this.isProjectRest()) {
      aclTable = 'nc_routes';
    } else if (this.isProjectGrpc()) {
      aclTable = 'nc_rpc';
    }

    let trx;
    try {
      trx = await client.knex.transaction();
      const role = await trx('nc_roles').where({id: args.args.id}).first();
      if (!role) {
        throw new Error(`Role with id '${args.args.id}' not found`);
      }
      const deleteRoleName = role.title;

      const aclRows = await trx(aclTable).select();
      for (const aclRow of aclRows) {
        try {
          if (aclRow.acl) {
            const acl = JSON.parse(aclRow.acl);
            delete acl[deleteRoleName];
            await trx(aclTable).update({
              acl: JSON.stringify(acl)
            }).where({
              id: aclRow.id
            });
          }
        } catch (e) {
          console.log(e);
        }
      }


      await trx('nc_roles').where({id: args.args.id}).del();

      await trx.commit();

    } catch
      (e) {
      if (trx) {
        trx.rollback(e);
      }
      throw e;
    }
  }

  // NOTE: update
  protected async xcResolverHandlerUpdate(args): Promise<any> {
    // const client = await this.projectGetSqlClient(args);
    const dbAlias = this.getDbAlias(args);

    try {
      await this.xcMeta.metaUpdate(args.project_id, dbAlias, 'nc_resolvers', {
        functions: JSON.stringify(args.args.functions)
      }, {
        title: args.args.tn,
        resolver: args.args.resolver
      })
    } catch (e) {
      throw e;
    }


  }


  // NOTE: xc-meta
  protected async xcResolverMiddlewareUpdate(args): Promise<any> {
    const client = await this.projectGetSqlClient(args);

    try {
      await client.knex('nc_resolvers').update({
        functions: JSON.stringify(args.args.functions)
      }).where({
        title: args.args.tn,
        handler_type: 2
      })
    } catch (e) {
      throw e;
    }


  }


  // NOTE: updated
  protected async defaultRestHandlerCodeGet(args): Promise<any> {
    const dbAlias = await this.getDbAlias(args);
    const modelMeta = await this.xcMeta.metaGet(args.project_id, dbAlias, 'nc_models', {'title': args.args.tn});

    const meta = JSON.parse(modelMeta.meta)
    const ctx = {
      routeVersionLetter: this.getRouteVersionLetter(args),
      tn: args.args.tn,
      _tn: meta && meta._tn,
      type: meta.type
    };


    let routes;


    // todo: pass table name alias
    if (args.args.relation_type === 'hasMany') {
      const modelMeta = await this.xcMeta.metaGet(args.project_id, dbAlias, 'nc_models', {'title': args.args.tnc});
      const meta = JSON.parse(modelMeta.meta)
      Object.assign(ctx, {
        tnc: args.args.tnc,
        _ctn: meta && meta._tn
      })
      routes = new ExpressXcTsRoutesHm({ctx}).getObject();
    } else if (args.args.relation_type === 'belongsTo') {
      // const modelMeta = await client.knex('xc_models').where('title', args.args.tnp).first();
      const modelMeta = await this.xcMeta.metaGet(args.project_id, dbAlias, 'nc_models', {'title': args.args.tnp});
      const meta = JSON.parse(modelMeta.meta)
      Object.assign(ctx, {
        rtn: args.args.tnp,
        _rtn: meta && meta._tn
      })
      routes = new ExpressXcTsRoutesBt({ctx}).getObject();

    } else {
      routes = new ExpressXcTsRoutes({ctx}).getObject();
    }

    const route = routes.find(route => route.path === args.args.path && route.type === args.args.type);
    if (route) {
      return route.functions;
    }
  }


  protected projectGetSqlClient(args) {
    const builder = this.getBuilder(args);
    return builder?.getSqlClient();
  }

  protected getBuilder(args): RestApiBuilder | GqlApiBuilder {
    return this.app.projectBuilders.find(pb => pb.id === args.project_id)?.apiBuilders?.find(builder => {
      return (args?.dbAlias || args?.args?.dbAlias) === builder.getDbAlias();
    })
  }

  protected getDbAlias(args): string {
    return args?.dbAlias || args?.args?.dbAlias;
  }


  protected isProjectRest() {
    return this.config.projectType.toLowerCase() === 'rest';
  }

  protected isProjectGrpc() {
    return this.config.projectType.toLowerCase() === 'grpc';
  }

  protected isProjectGraphql() {
    return this.config.projectType.toLowerCase() === 'graphql';
  }

  protected getRouteVersionLetter(args): string | void {
    const dbs = this.config.envs[args.env][this.getDbAlias(args)];
    for (let index = 0; index < dbs.length; index++) {
      const db = dbs[index];
      if (db.meta.dbAlias === args.dbAlias) {
        if (db.meta && db.meta.api && db.meta.api.prefix) {
          return db.meta.api.prefix;
        }
        return this.genVer(index)
      }
    }
  }

  protected genVer(i): string {
    const l = 'vwxyzabcdefghijklmnopqrstu';
    return i
      .toString(26)
      .split('')
      .map(v => l[parseInt(v, 26)])
      .join('') + '1';
  }

  protected async xcVirtualRelationCreate(args: any, req): Promise<any> {
    const dbAlias = this.getDbAlias(args);
    const projectId = this.getProjectId(args);

    const res = await this.xcMeta.metaInsert(projectId, dbAlias, 'nc_relations', {
      tn: args.args.childTable,
      cn: args.args.childColumn,
      rtn: args.args.parentTable,
      rcn: args.args.parentColumn,
      type: 'virtual',
      db_type: this.getDbClientType(args.project_id, dbAlias),
      dr: '',
      ur: '',
    })


    this.app.ncMeta.audit(projectId, dbAlias, 'nc_audit', {
      op_type: 'VIRTUAL_RELATION',
      op_sub_type: 'CREATED',
      user: req.user.email,
      description: `created virtual relation between tables ${args.args.childTable} and ${args.args.parentTable} `,
      ip: req.clientIp
    });

    return res;
  }


  protected async xcM2MRelationCreate(args: any, req): Promise<any> {
    const dbAlias = this.getDbAlias(args);
    const projectId = this.getProjectId(args);

    try {

      const parent = await this.xcMeta.metaGet(projectId, dbAlias, 'nc_models', {
        title: args.args.parentTable
      });
      const child = await this.xcMeta.metaGet(projectId, dbAlias, 'nc_models', {
        title: args.args.childTable
      });
      const parentMeta = JSON.parse(parent.meta);
      const childMeta = JSON.parse(child.meta);


      const parentPK = parentMeta.columns.find(c => c.pk);
      const childPK = childMeta.columns.find(c => c.pk);

      const associateTableCols = [];

      associateTableCols.push({
        cn: `${childMeta.tn}_id`,
        _cn: `${childMeta.tn}_id`,
        rqd: true,
        pk: true,
        ai: false,
        cdf: null,
        dt: childPK.dt,
        dtxp: childPK.dtxp,
        dtxs: childPK.dtxs,
        un: childPK.un,
        altered: 1
      }, {
        cn: `${parentMeta.tn}_id`,
        _cn: `${parentMeta.tn}_id`,
        rqd: true,
        pk: true,
        ai: false,
        cdf: null,
        dt: parentPK.dt,
        dtxp: parentPK.dtxp,
        dtxs: parentPK.dtxs,
        un: parentPK.un,
        altered: 1
      });

      const aTn = `${this.projectConfigs[projectId]?.prefix ?? ''}_nc_m2m_${parentMeta.tn}_${childMeta.tn}_${Math.floor(Math.random() * 1000)}`;

      const out = await this.projectMgr.getSqlMgr({id: projectId}).handleRequest('tableCreate', {
        ...args,
        args: {
          tn: aTn,
          _tn: aTn,
          columns: associateTableCols
        }
      });

      if (this.listener) {
        await this.listener({
          req: {
            ...args,
            args: {
              tn: aTn,
              _tn: aTn,
              columns: associateTableCols
            }, api: 'tableCreate'
          },
          res: out,
          user: req.user,
          ctx: {
            req
          }
        });
      }


      const rel1Args = {
        ...args.args,
        childTable: aTn,
        childColumn: `${parentMeta.tn}_id`,
        parentTable: parentMeta.tn,
        parentColumn: parentPK.cn,
        type: 'real'
      };
      const rel2Args = {
        ...args.args,
        childTable: aTn,
        childColumn: `${childMeta.tn}_id`,
        parentTable: childMeta.tn,
        parentColumn: childPK.cn,
        type: 'real'
      };
      if (args.args.type === 'real') {
        const outrel = await this.projectMgr.getSqlMgr({id: projectId}).handleRequest('relationCreate', {
          ...args,
          args: rel1Args
        });
        if (this.listener) {
          await this.listener({
            req: {
              ...args,
              args: rel1Args,
              api: 'relationCreate'
            },
            res: outrel,
            user: req.user,
            ctx: {
              req
            }
          });
        }
        const outrel1 = await this.projectMgr.getSqlMgr({id: projectId}).handleRequest('relationCreate', {
          ...args,
          args: rel2Args
        });
        if (this.listener) {
          await this.listener({
            req: {
              ...args,
              args: rel2Args,
              api: 'relationCreate'
            },
            res: outrel1,
            user: req.user,
            ctx: {
              req
            }
          });
        }
      } else {
        const outrel = await this.xcVirtualRelationCreate({...args, args: rel1Args}, req);
        if (this.listener) {
          await this.listener({
            req: {
              ...args,
              args: rel1Args,
              api: 'xcVirtualRelationCreate'
            },
            res: outrel,
            user: req.user,
            ctx: {
              req
            }
          });
        }
        const outrel1 = await this.xcVirtualRelationCreate({...args, args: rel2Args}, req);
        await this.listener({
          req: {
            ...args,
            args: rel2Args,
            api: 'xcVirtualRelationCreate'
          },
          res: outrel1,
          user: req.user,
          ctx: {
            req
          }
        });
      }

    } catch (e) {
      console.log(e.message)
    }


  }


  // todo : transaction
  protected async xcRelationColumnDelete(args: any, req, deleteColumn = true): Promise<any> {
    const dbAlias = this.getDbAlias(args);
    const projectId = this.getProjectId(args);

    // const parent = await this.xcMeta.metaGet(projectId, dbAlias, 'nc_models', {
    //   title: args.args.parentTable
    // });
    // // @ts-ignore
    // const parentMeta = JSON.parse(parent.meta);
    // @ts-ignore
    // todo: compare column
    switch (args.args.type) {
      case 'bt':
      case 'hm':
        const child = await this.xcMeta.metaGet(projectId, dbAlias, 'nc_models', {
          title: args.args.childTable
        });
        const childMeta = JSON.parse(child.meta);
        const relation = childMeta.belongsTo.find(bt => bt.rtn === args.args.parentTable);
        // todo: virtual relation delete
      if(relation){
        const opArgs = {
          ...args,
          args: {
            childColumn: relation.cn,
            childTable: relation.tn,
            parentTable: relation.rtn,
            parentColumn: relation.rcn
          },
          api: 'relationDelete',
          sqlOpPlus: true,
        };
        let out;
        if (relation?.type === 'virtual') {
          opArgs.api = 'xcVirtualRelationDelete';
          out = await this.xcVirtualRelationDelete(opArgs, req);
        } else {
          out = await this.projectMgr.getSqlMgr({id: projectId}).handleRequest('relationDelete', opArgs);
        }
        if (this.listener) {
          await this.listener({
            req: opArgs,
            res: out,
            user: req.user,
            ctx: {req}
          });
        }
      }
        if (deleteColumn) {
          const originalColumns = childMeta.columns;
          const columns = childMeta.columns.map(c => ({
            ...c, ...(relation.cn === c.cn ? {
              altered: 4,
              cno: c.cn
            } : {cno: c.cn})
          }))

          const opArgs = {
            ...args,
            args: {
              columns,
              originalColumns,
              tn: childMeta.tn,
            },
            sqlOpPlus: true,
            api: 'tableUpdate'
          }
          const out = await this.projectMgr.getSqlMgr({id: projectId}).handleRequest('tableUpdate', opArgs);

          if (this.listener) {
            await this.listener({
              req: opArgs,
              res: out,
              user: req.user,
              ctx: {req}
            });
          }
        }
        break;
      case 'mm': {
        const assoc = await this.xcMeta.metaGet(projectId, dbAlias, 'nc_models', {
          title: args.args.assocTable
        });
        const assocMeta = JSON.parse(assoc.meta);
        const rel1 = assocMeta.belongsTo.find(bt => bt.rtn === args.args.parentTable)
        const rel2 = assocMeta.belongsTo.find(bt => bt.rtn === args.args.childTable)
        await this.xcRelationColumnDelete({
          ...args,
          args: {
            parentTable: rel1.rtn,
            parentColumn: rel1.rcn,
            childTable: rel1.tn,
            childColumn: rel1.cn,
            type: 'bt',
          }
        }, req, false)
        await this.xcRelationColumnDelete({
          ...args,
          args: {
            parentTable: rel2.rtn,
            parentColumn: rel2.rcn,
            childTable: rel2.tn,
            childColumn: rel2.cn,
            type: 'bt',
          }
        }, req, false);


        const opArgs = {
          ...args,
          args: assocMeta,
          api: 'tableDelete',
          sqlOpPlus: true,
        };
        const out = await this.projectMgr.getSqlMgr({id: projectId}).handleRequest('tableDelete', opArgs);

        if (this.listener) {
          await this.listener({
            req: opArgs,
            res: out,
            user: req.user,
            ctx: {req}
          });
        }

      }
        break;
    }


  }

  protected async xcVirtualRelationDelete(args: any, req): Promise<any> {
    const dbAlias = this.getDbAlias(args);
    const projectId = this.getProjectId(args);

    const res = await this.xcMeta.metaDelete(projectId, dbAlias, 'nc_relations', {
      tn: args.args.childTable,
      cn: args.args.childColumn,
      rtn: args.args.parentTable,
      rcn: args.args.parentColumn,
      type: 'virtual'
    })


    this.app.ncMeta.audit(projectId, dbAlias, 'nc_audit', {
      op_type: 'VIRTUAL_RELATION',
      op_sub_type: 'DELETED',
      user: req.user.email,
      description: `deleted virtual relation between tables ${args.args.childTable} and ${args.args.parentTable} `,
      ip: req.clientIp
    });

    return res;

  }


  protected async xcRelationList(args: any): Promise<any> {
    const dbAlias = this.getDbAlias(args);
    // const sqlClient = this.getSqlClient(args.project_id, dbAlias);
    // console.time('relationList')
    // const relations = (await sqlClient.relationList(args.args))?.data?.list;
    // console.timeEnd('relationList')
    // console.time('virtualRelationList')
    const virtualRelation = await this.xcMeta.metaList(args.project_id, dbAlias, 'nc_relations', {
      condition: {
        // type: 'virtual',
        tn: args.args.tn
      }
    });
    return virtualRelation;
    // console.timeEnd('virtualRelationList')

    // const mergedRelation = [...relations, ...virtualRelation];
    //
    // return mergedRelation;
  }


  protected getDbClientType(project_id: string, dbAlias: string) {
    const config = this.app?.projectBuilders?.find(pb => pb?.id === project_id)?.config;
    return config?.envs?.[this.config?.workingEnv || 'dev']?.db?.find(db => db?.meta?.dbAlias === dbAlias)?.client;
  }


  protected getDbAliasList(project_id: string): string[] {
    return this.projectConfigs?.[project_id]?.envs?.[this.config?.workingEnv || 'dev']?.db?.map(db => db?.meta?.dbAlias);
  }


  // @ts-ignore
  protected getSqlClient(project_id: string, dbAlias: string) {
    return this.app?.projectBuilders
      ?.find(pb => pb?.id === project_id)
      ?.apiBuilders
      ?.find(builder => builder.dbAlias === dbAlias)
      ?.getSqlClient();
  }

  protected async createSharedViewLink(req, args: any): Promise<any> {
    try {
      if (args.args.query_params?.fields) {
        const fields = args.args.query_params?.fields.split(',');
        args.args.meta.columns = args.args.meta.columns.filter(c => fields.includes(c._cn))
      }


      const insertData = {
        project_id: args.project_id,
        db_alias: this.getDbAlias(args),
        model_name: args.args.model_name,
        meta: JSON.stringify(args.args.meta),
        query_params: JSON.stringify(args.args.query_params),
        view_id: uuidv4(),
        // password: args.args.password
      }

      await this.xcMeta.metaInsert(args.project_id, this.getDbAlias(args), 'nc_shared_views', insertData);
      const res = await this.xcMeta.metaGet(this.getProjectId(args), this.getDbAlias(args), 'nc_shared_views', insertData, ['id', 'view_id']);
      res.url = `${req.ncSiteUrl}${this.config.dashboardPath}#/nc/view/${res.view_id}`;
      Tele.emit('evt', {evt_type: 'sharedView:generated-link'})
      return res;
    } catch (e) {
      console.log(e)
    }
  }

  protected async updateSharedViewLinkPassword(_args: any): Promise<any> {
    // try {
    //
    //   await this.xcMeta.metaUpdate(this.getProjectId(args), this.getDbAlias(args), 'nc_shared_views', {
    //     password: args.args?.password
    //   }, args.args.id);
    //   Tele.emit('evt', {evt_type: 'sharedView:password-updated'})
    //   return {msg: 'Success'};
    // } catch (e) {
    //   console.log(e)
    // }

    throw new XCEeError('Upgrade to Enterprise Edition')
  }

  protected async deleteSharedViewLink(args: any): Promise<any> {
    try {

      await this.xcMeta.metaDelete(this.getProjectId(args), this.getDbAlias(args), 'nc_shared_views', args.args.id);
      Tele.emit('evt', {evt_type: 'sharedView:deleted'})
      return {msg: 'Success'};
    } catch (e) {
      console.log(e)
    }
  }


  protected async displaySharedViewLink(args: any): Promise<any> {
    return this.xcMeta.metaGet(args.project_id, this.getDbAlias(args), 'nc_shared_views', {
      view_id: {
        _eq: args.args.view_id
      }
    });
  }

  protected async listSharedViewLinks(args: any): Promise<any> {
    return this.xcMeta.metaList(args.project_id, this.getDbAlias(args), 'nc_shared_views', {
      condition: {
        model_name: args.args.model_name
      },
      fields: [
        'id',
        'view_id',
        'password',
        'model_name'
      ]
    });
  }

  protected async getSharedViewData(req, args: any): Promise<any> {
    try {
      console.log(args)
      const viewMeta = await this.xcMeta.knex('nc_shared_views').where({
        view_id: args.args.view_id
      }).first();

      // if (viewMeta && viewMeta.password && viewMeta.password !== args.args.password) {
      //   throw new Error('Invalid password')
      // }


      const apiBuilder = this.app
        ?.projectBuilders
        ?.find(pb => pb.id === viewMeta.project_id)
        ?.apiBuilders
        ?.find(ab => ab.dbAlias === viewMeta.db_alias);
      const model = apiBuilder?.xcModels?.[viewMeta.model_name];

      if (model) {
        const queryParams = JSON.parse(viewMeta.query_params);
        let where = '';

        if (req.query.where) {
          where += req.query.where;
        }

        if (queryParams.where) {
          where += where ? `~and(${queryParams.where})` : queryParams.where;
        }

        const fields = queryParams?.fields || '*';

        return {
          model_name: viewMeta.model_name,
          meta: JSON.parse(viewMeta.meta),
          data: await model.list({
            ...req.query,
            where,
            fields
          }),
          ...await model.countByPk({
            ...req.query,
            where,
            fields
          }),
          client: apiBuilder?.client
        }

      }

    } catch (e) {
      throw e;
    }

  }

  protected async xcAuthHookGet(args: any): Promise<any> {
    try {
      return await this.xcMeta.metaGet(args.project_id, 'db', 'nc_hooks', {
        type: 'AUTH_MIDDLEWARE'
      });
    } catch (e) {
      console.log(e)
    }
  }

  protected async xcAuthHookSet(args: any): Promise<any> {
    // todo: add all params
    if (await this.xcMeta.metaGet(args.project_id, 'db', 'nc_hooks', {
      type: 'AUTH_MIDDLEWARE'
    })) {
      return this.xcMeta.metaUpdate(args.project_id, 'db', 'nc_hooks', {
        url: args.args.url
      }, {
        type: 'AUTH_MIDDLEWARE'
      });
    }

    return this.xcMeta.metaInsert(args.project_id, 'db', 'nc_hooks', {
      url: args.args.url,
      type: 'AUTH_MIDDLEWARE'
    });
  }


  protected async xcTableList(_req, args): Promise<any> {

    // const roles = req.session?.passport?.user?.roles;

    const tables = (await this.xcVisibilityMetaGet({...args, args: {type: 'table', ...args.args}}));
    // if (this.isEe) {
    //   tables = tables.filter((table: any) => {
    //     return Object.keys(roles).some(role => roles[role] && !table.disabled[role])
    //   });
    // }


    return {data: {list: tables}};
  }

  protected async xcColumnList(args): Promise<any> {
    try {
      const modelMeta = (await this.xcMeta.metaGet(this.getProjectId(args), this.getDbAlias(args), 'nc_models', {
        title: args.args.tn,
        type: 'table'
      }));


      if (modelMeta) {
        const columns = JSON.parse(modelMeta.meta).columns
        for (const column of columns) {
          // todo:
          column.tn = args.args.tn;
          column.cno = column.cn;
        }
        return {data: {list: columns}};
      }

      return this.projectGetSqlClient(args).columnList(args.args);
    } catch (e) {
      throw e
    }
  }

  protected async xcFunctionList(req, args): Promise<any> {

    const roles = req.session?.passport?.user?.roles;

    const functions = (await this.xcVisibilityMetaGet({...args, args: {type: 'function'}}))
      .filter((functionObj: any) => {
        return Object.keys(roles).some(role => roles[role] && !functionObj.disabled[role])
      });


    return {data: {list: functions}};
  }


  protected async xcViewList(req, args): Promise<any> {

    const roles = req.session?.passport?.user?.roles;

    const views = (await this.xcVisibilityMetaGet({...args, args: {type: 'view'}}))
      .filter((view: any) => {
        return Object.keys(roles).some(role => roles[role] && !view.disabled[role])
      });

    return {data: {list: views}};
  }


  protected async xcProcedureList(req, args): Promise<any> {

    const roles = req.session?.passport?.user?.roles;

    const procedures = (await this.xcVisibilityMetaGet({...args, args: {type: 'procedure'}}))
      .filter((procedure: any) => {
        return Object.keys(roles).some(role => roles[role] && !procedure.disabled[role])
      });


    return {data: {list: procedures}};
  }


  // @ts-ignore
  protected async xcVisibilityMetaGet(args) {
    try {

      const roles = (await this.xcMeta.metaList('', '', 'nc_roles'))
        .map(r => r.title)
        .filter(role => !['owner', 'guest', 'creator'].includes(role))

      const defaultDisabled = roles.reduce((o, r) => ({...o, [r]: false}), {})

      const sqlClient = this.projectGetSqlClient(args);


      switch (args.args.type) {
        case 'table': {
          let tables = await this.xcMeta.metaList(this.getProjectId(args), this.getDbAlias(args), 'nc_models', {
            condition: {
              type: 'table'
            }
          });

          if (args.args.force) {
            tables = (await sqlClient.tableList())?.data?.list?.map(table => {
              return tables.find(mod => mod.title === table.tn) ?? {title: table.tn, alias: table.tn};
            });
          }

          const result = tables.reduce((obj, table) => {
            obj[table.title] = {
              tn: table.title,
              _tn: table.alias,
              disabled: {...defaultDisabled}
            };
            return obj;
          }, {})

          const disabledList = await this.xcMeta.metaList(args.project_id, this.getDbAlias(args), 'nc_disabled_models_for_role', {
            condition: {
              type: 'table'
            }
          })

          for (const d of disabledList) {
            result[d.title].disabled[d.role] = !!d.disabled;
          }

          return Object.values(result);
        }
          break;
        case 'view': {
          // const views = (await sqlClient.viewList())?.data?.list;
          const views = await this.xcMeta.metaList(this.getProjectId(args), this.getDbAlias(args), 'nc_models', {
            condition: {
              type: 'view'
            }
          });


          const result = views.reduce((obj, view) => {
            obj[view.view_name] = {
              view_name: view.title,
              _tn: view.alias,
              disabled: {...defaultDisabled}
            };
            return obj;
          }, {})

          const disabledList = await this.xcMeta.metaList(args.project_id, this.getDbAlias(args), 'nc_disabled_models_for_role', {
            condition: {
              type: 'view'
            }
          })

          for (const d of disabledList) {
            result[d.title].disabled[d.role] = d.disabled;
          }

          return Object.values(result);
        }

          break;
        case 'function': {
          const views = (await sqlClient.functionList())?.data?.list;

          const result = views.reduce((obj, view) => {
            obj[view.function_name] = {
              function_name: view.function_name,
              disabled: {...defaultDisabled}
            };
            return obj;
          }, {})

          const disabledList = await this.xcMeta.metaList(args.project_id, this.getDbAlias(args), 'nc_disabled_models_for_role', {
            condition: {
              type: 'function'
            }
          })

          for (const d of disabledList) {
            result[d.title].disabled[d.role] = d.disabled;
          }

          return Object.values(result);
        }

          break;
        case 'procedure': {
          const procedures = (await sqlClient.procedureList())?.data?.list;

          const result = procedures.reduce((obj, view) => {
            obj[view.procedure_name] = {
              procedure_name: view.procedure_name,
              disabled: {...defaultDisabled}
            };
            return obj;
          }, {})

          const disabledList = await this.xcMeta.metaList(args.project_id, this.getDbAlias(args), 'nc_disabled_models_for_role', {
            condition: {
              type: 'procedure'
            }
          })

          for (const d of disabledList) {
            result[d.title].disabled[d.role] = d.disabled;
          }

          return Object.values(result);
        }
          break;
        case 'relation':

          const relations = await this.xcRelationsGet(args);

          const result = relations.reduce((obj, relation) => {
            obj[[
              relation.tn,
              relation.relationType,
              relation.rtn,
              relation.cn,
              relation.rcn
            ].join('||')] = {
              ...relation,
              disabled: {...defaultDisabled}
            };
            return obj;
          }, {})


          const disabledList = await this.xcMeta.metaList(args.project_id, this.getDbAlias(args), 'nc_disabled_models_for_role', {
            condition: {
              type: 'relation'
            }
          });

          for (const d of disabledList) {
            const key = [
              d.tn,
              d.relation_type,
              d.rtn,
              d.cn,
              d.rcn].join('||');
            if (key in result) {
              result[key].disabled[d.role] = d.disabled;
            }
          }
          return Object.values(result);
          break;
      }
    } catch (e) {
      throw e;
    }
  }

  // @ts-ignore
  protected async xcVisibilityMetaSet(args) {
    // if (!this.isEe) {
    throw new XCEeError('Please upgrade')
    // }

    // try {
    //   let field = '';
    //   switch (args.args.type) {
    //     case 'table':
    //       field = 'tn';
    //       break;
    //     case 'function':
    //       field = 'function_name';
    //       break;
    //     case 'procedure':
    //       field = 'procedure_name';
    //       break;
    //     case 'view':
    //       field = 'view_name';
    //       break;
    //     case 'relation':
    //       field = 'relationType';
    //       break;
    //   }
    //
    //   for (const d of args.args.disableList) {
    //     const props = {};
    //     if (field === 'relationType') {
    //       Object.assign(props, {
    //         tn: d.tn,
    //         rtn: d.rtn,
    //         cn: d.cn,
    //         rcn: d.rcn,
    //         relation_type: d.relationType
    //       })
    //     }
    //     for (const role of Object.keys(d.disabled)) {
    //       const dataInDb = await this.xcMeta.metaGet(this.getProjectId(args), this.getDbAlias(args), 'nc_disabled_models_for_role', {
    //         type: args.args.type,
    //         title: d[field],
    //         role,
    //         ...props
    //       });
    //       if (dataInDb) {
    //         if (d.disabled[role]) {
    //           if (!dataInDb.disabled) {
    //             await this.xcMeta.metaUpdate(this.getProjectId(args), this.getDbAlias(args), 'nc_disabled_models_for_role', {
    //               disabled: d.disabled[role]
    //             }, {
    //               type: args.args.type,
    //               title: d[field],
    //               role, ...props
    //             })
    //           }
    //         } else {
    //
    //           await this.xcMeta.metaDelete(this.getProjectId(args), this.getDbAlias(args), 'nc_disabled_models_for_role', {
    //             type: args.args.type,
    //             title: d[field],
    //             role, ...props
    //           })
    //         }
    //       } else if (d.disabled[role]) {
    //         await this.xcMeta.metaInsert(this.getProjectId(args), this.getDbAlias(args), 'nc_disabled_models_for_role', {
    //           disabled: d.disabled[role],
    //           type: args.args.type,
    //           title: d[field],
    //           role, ...props
    //         })
    //
    //       }
    //     }
    //   }
    //
    //
    // } catch (e) {
    //   throw e;
    // }
  }

  protected async xcPluginList(_args): Promise<any> {
    return this.xcMeta.metaList(null, null, 'nc_plugins');
  }

  protected async xcPluginRead(args): Promise<any> {
    return this.xcMeta.metaGet(null, null, 'nc_plugins', {title: args.args.title});
  }

  protected async xcPluginTest(req, args): Promise<any> {
    try {
      switch (args.args.category) {
        case 'Email':
          const emailIns = EmailFactory.createNewInstance(args.args, args.args.input)
          await emailIns.init();
          await emailIns?.test(req.user?.email)
          break;
        default:
          return this.pluginMgr.test(args.args)
          break;
      }
      return true;
    } catch (e) {
      throw e;
    }
  }

  protected async xcPluginCreate(_args): Promise<any> {

  }

  protected async xcPluginDelete(_args): Promise<any> {

  }

  protected async xcPluginSet(args): Promise<any> {
    try {

      if (args.args.title === 'Branding' && !this.isEe) {
        throw new XCEeError('Upgrade to Enterprise Edition');
      }

      await this.xcMeta.metaUpdate(null, null, 'nc_plugins', {
        input: args.args.input ? JSON.stringify(args.args.input) : null,
        status: args.args.uninstall ? '' : 'installed',
        active: !args.args.uninstall,

      }, {title: args.args.title, id: args.args.id});


      // await this.initStorage(true)
      // await this.initEmail(true)
      // await this.initTwilio(true)
      this.pluginMgr?.reInit();
      await this.initCache(true)
      this.eeVerify();
      try {
        RestAuthCtrl.instance.initStrategies()
      } catch (e) {
      }

    } catch (e) {
      throw e;
    } finally {
      Tele.emit('evt', {evt_type: 'plugin:installed', title: args.args.title})
    }
  }


  protected getProjectId(args): string {
    return args.project_id;
  }

  // @ts-ignore
  protected xcVersionLetters(args) {
    // const _vesions ={db:'v1'};
    // for(const  {meta: {_dbAlias}} of this.projectConfigs[args.project_id].envs[args.env].db) {
    //
    // }
  }

  protected async xcVirtualTableCreate(args, req): Promise<any> {
    const parentModel = await this.xcMeta.metaGet(this.getProjectId(args), this.getDbAlias(args), 'nc_models', {
      title: args.args.parent_model_title
    }, null, {
      type: {
        in: ['table', 'view']
      }
    });

    if (!parentModel) {
      return
    }

    const data: any = {
      title: args.args.title,
      type: 'vtable',
      // meta: parentModel.meta,
      query_params: JSON.stringify(args.args.query_params),
      parent_model_title: args.args.parent_model_title,
      show_as: args.args.show_as
    };
    const projectId = this.getProjectId(args);
    const dbAlias = this.getDbAlias(args);
    const id = await this.xcMeta.metaInsert(projectId, dbAlias, 'nc_models', data);
    data.id = id?.[0] || id;

    this.xcMeta.audit(projectId, dbAlias, 'nc_audit', {
      op_type: 'TABLE_VIEW',
      op_sub_type: 'CREATED',
      user: req.user.email,
      description: `created view(${args.args.title}) for table(${args.args.parent_model_title}) `,
      ip: req.clientIp
    })


    Tele.emit('evt', {evt_type: 'vtable:created', show_as: args.args.show_as})
    return data;
  }

  protected async xcApiTokenList(_args): Promise<any> {

    return this.xcMeta.metaList(null, null, 'nc_api_tokens');
  }

  protected async xcPluginDemoDefaults(_args): Promise<any> {
    if (!process.env.NC_DEMO) {
      return {};
    }
    let pluginDet = XcCache.get(XC_PLUGIN_DET)
    if (pluginDet) {
      return pluginDet;
    }
    pluginDet = (await axios.post('https://nocodb.com/api/v1/pluginDemoDefaults', {
      key: process.env.NC_DEMO
    }))?.data;

    XcCache.set(XC_PLUGIN_DET, pluginDet);
    return pluginDet;
  }

  protected async xcAuditList(_args): Promise<any> {
    throw new XCEeError('Upgrade to Enterprise Edition')
  }

  protected async xcModelRowAuditAndCommentList(args): Promise<any> {
    const audits = await this.xcMeta.metaPaginatedList(this.getProjectId(args), this.getDbAlias(args), 'nc_audit', {
      limit: args.args.limit,
      offset: args.args.offset,
      sort: {
        field: 'created_at',
        desc: false
      },
      condition: {
        model_id: args.args.model_id,
        model_name: args.args.model_name,
      }
    });


    return audits;
  }

  protected async xcAuditCommentInsert(args, req): Promise<any> {
    return this.xcMeta.audit(this.getProjectId(args), this.getDbAlias(args), 'nc_audit', {
      description: args.args.description,
      model_id: args.args.model_id,
      model_name: args.args.model_name,
      op_type: 'COMMENT',
      op_sub_type: 'INSERT',
      user: req.user?.email,
      ip: req.clientIp,
    });

  }


  protected async xcAuditCreate(args, req): Promise<any> {
    return this.xcMeta.audit(this.getProjectId(args), this.getDbAlias(args), 'nc_audit', {
      model_name: args.args.tn,
      model_id: args.args.pk,
      op_type: 'DATA',
      op_sub_type: 'UPDATE',
      description: `Table ${args.args.tn} : field ${args.args.cn} got changed from  ${args.args.prevValue} to ${args.args.value}`,
      details: `<span class="">${args.args.cn}</span>
  : <span class="text-decoration-line-through red px-2 lighten-4 black--text">${args.args.prevValue}</span>
  <span class="black--text green lighten-4 px-2">${args.args.value}</span>`,
      ip: req.clientIp,
      user: req.user?.email
    });
  }

  protected async xcAuditModelCommentsCount(args): Promise<any> {
    return this.xcMeta.knex('nc_audit')
      .select('model_id')
      .count('model_id', {as: 'count'})
      .where({
        project_id: this.getProjectId(args),
        db_alias: this.getDbAlias(args),
        model_name: args.args.model_name,
        op_type: 'COMMENT',
        // op_sub_type: 'COMMENT',
      }).whereIn('model_id', args.args.ids).groupBy('model_id');
  }

  protected async xcApiTokenCreate(args): Promise<any> {
    const token = nanoid(40);
    await this.xcMeta.metaInsert(null, null, 'nc_api_tokens', {
      description: args.args.description,
      token
    });
    await RestAuthCtrl.instance.loadLatestApiTokens();

    Tele.emit('evt', {evt_type: 'apiToken:created'});
    return {
      description: args.args.description,
      token
    }
  }

  protected async xcApiTokenUpdate(_args): Promise<any> {
    return null;
  }

  protected async xcApiTokenDelete(args): Promise<any> {
    Tele.emit('evt', {evt_type: 'apiToken:deleted'});
    const res = await this.xcMeta.metaDelete(null, null, 'nc_api_tokens', args.args.id);
    await RestAuthCtrl.instance.loadLatestApiTokens();
    return res;
  }


  protected async xcVirtualTableRename(args, req): Promise<any> {
    const projectId = this.getProjectId(args);
    const dbAlias = this.getDbAlias(args);
    const result = await this.xcMeta.metaUpdate(projectId, dbAlias, 'nc_models', {
      title: args.args.title,
    }, args.args.id);

    this.xcMeta.audit(projectId, dbAlias, 'nc_audit', {
      op_type: 'TABLE_VIEW',
      op_sub_type: 'RENAMED',
      user: req.user.email,
      description: `renamed view(${args.args.title}, ${args.args.id}) for table(${args.args.parent_model_title}) `,
      ip: req.clientIp
    })

    Tele.emit('evt', {evt_type: 'vtable:renamed', show_as: args.args.show_as})
    return result;
  }

  protected async xcVirtualTableUpdate(args): Promise<any> {
    // Tele.emit('evt', {evt_type: 'vtable:updated',show_as: args.args.show_as})
    return this.xcMeta.metaUpdate(this.getProjectId(args), this.getDbAlias(args), 'nc_models', {
      query_params: JSON.stringify(args.args.query_params),
    }, args.args.id);
  }


  protected async ncProjectInfo(args) {

    const config = this.projectConfigs[this.getProjectId(args)];
    return {
      Node: process.version,
      Arch: process.arch,
      Platform: process.platform,
      Docker: isDocker(),
      Database: config.envs?.[process.env.NODE_ENV || 'dev']?.db?.[0]?.client,
      'ProjectOnRootDB': !!config?.prefix,
      'RootDB': this.config?.meta?.db?.client,
      'PackageVersion': packageInfo?.version
    }
  }

  protected async xcVirtualTableList(args): Promise<any> {
    return (await this.xcMeta.metaList(this.getProjectId(args), this.getDbAlias(args), 'nc_models', {
      xcCondition: {
        _or: [{
          parent_model_title: {
            eq: args.args.tn
          },
        }, {
          title: {
            eq: args.args.tn
          },
        }]
      },
      fields: [
        'id',
        'alias',
        'meta',
        'parent_model_title',
        'query_params',
        'show_as',
        'title',
        'type'
      ]
      // todo: handle sort
    })).sort((a, b) => +(a.type === 'vtable' ? a.id : -Infinity) - +(b.type === 'vtable' ? b.id : -Infinity));
  }

  protected async xcVirtualTableDelete(args, req): Promise<any> {
    const projectId = this.getProjectId(args);
    const dbAlias = this.getDbAlias(args);
    const res = await this.xcMeta.metaDelete(projectId, dbAlias, 'nc_models', {
      type: 'vtable',
      parent_model_title: args.args.parent_model_title,
      id: args.args.id
    });
    this.xcMeta.audit(projectId, dbAlias, 'nc_audit', {
      op_type: 'TABLE_VIEW',
      op_sub_type: 'DELETED',
      user: req.user.email,
      description: `deleted view(${args.args.title}, ${args.args.id}) of parent table(${args.args.parent_model_title}) `,
      ip: req.clientIp
    })

    Tele.emit('evt', {evt_type: 'vtable:deleted'})
    return res;
  }


  // @ts-ignore
  protected async eeVerify() {
    try {
      const eeDetails = await this.xcMeta.metaGet(null, null, 'nc_plugins', {
        category: 'Enterprise',
      });

      if (eeDetails?.input) {
        // @ts-ignore
        const eeConfig = JSON.parse(eeDetails?.input);
        this.isEe = false;

        await axios.post('http://localhost:3000/api/v1/subscription/e62a4252-748a-4474-861e-ca291359130e', {
          key: eeConfig.key
        })

        // todo: verify client id and secret
        // this.isEe = true;
      }
    } catch (e) {
      console.log(e);
    }
  }


  protected cacheModelSet(project_id: string, db_alias: string, type: string, model_name: string, model: any): boolean {
    return XcCache.set([project_id, db_alias, type, model_name].join('::'), model);
  }

  protected cacheModelGet(project_id: string, db_alias: string, type: string, model_name: string): any {
    return XcCache.get([project_id, db_alias, type, model_name].join('::'));
  }

  protected cacheModelDel(project_id: string, db_alias: string, type: string, model_name): void {
    XcCache.del([project_id, db_alias, type, model_name].join('::'));
  }

  protected get storageAdapter(): IStorageAdapter {
    return this.pluginMgr?.storageAdapter;
  }

  public get emailAdapter(): IEmailAdapter {
    return this.pluginMgr?.emailAdapter;
  }

  public get webhookNotificationAdapters() {
    return this.pluginMgr?.webhookNotificationAdapters;
  }

}


export class XCEeError extends Error {
  public static throw() {
    throw new XCEeError('Upgrade to Enterprise Edition')
  }
}

/**
 * @copyright Copyright (c) 2021, Xgene Cloud Ltd
 *
 * @author Naveen MR <oof1lab@gmail.com>
 * @author Pranav C Balan <pranavxc@gmail.com>
 *
 * @license GNU AGPL version 3 or any later version
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 *
 */

