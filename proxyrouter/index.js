/**
 * proxy router
 */
var http = require('http');
var util = require('util');
var events = require('events');
var url =  require("url");
var async  = require('async');
var myredis = require('../lib/myredis.js');
require('../lib/jsextend.js');
var logger;
var PROXY_KEYS = 'proxy:public:available:3s';

/////////////////////////////////////////////////////////////////
var proxyRouter = function(settings){
	events.EventEmitter.call(this);//eventemitter inherits
	this.settings = settings;
	logger = settings['logger'];
    this.handleCount = 0;//proxy handle count. once proxy list change, reset to 0.
    this.proxyServeMap = {};
    this.availableProxies = {};/*{domain:{$IP$:true}}*/
}

util.inherits(proxyRouter, events.EventEmitter);//eventemitter inherits
/**
 * trigger
 */
proxyRouter.prototype.start = function(){
    var self = this;
    var dbtype = 'redis';
    if(self.settings['use_ssdb'])dbtype = 'ssdb';
    myredis.createClient(
        self.settings['proxy_info_redis_db'][0],
        self.settings['proxy_info_redis_db'][1],
        self.settings['proxy_info_redis_db'][2],
        dbtype,
        function(err,cli){
            self.redis_cli3 = cli;
            self.proxyDaemon();
        });
}

/**
 * TOP Domain,e.g: www.baidu.com  -> baidu.com
 * @param domain
 * @returns {*}
 * @private
 */
proxyRouter.prototype.__getTopLevelDomain = function(domain){
    var arr = domain.split('.');
    if(arr.length<=2)return domain;
    else return arr.slice(1).join('.');
}

/**
 * Choose proxy, if it request come from browser, keep a proxy for resources of page
 * @param ip
 * @param header
 * @returns {*}
 * @private
 */
proxyRouter.prototype.__chooseProxy = function(domain,ip,header,callback){
    var proxyRouter = this;
    this.handleCount++;
    if(header['client_pid']&&header['page']){
        var browserId = ip+':'+header['client_pid'];
        if(!this.proxyServeMap[browserId]||this.proxyServeMap[browserId][0]!==header['page']||!this.availableProxies[domain][this.proxyServeMap[browserId][1]]){
            proxyRouter.__getProxyFromDb(domain,function(domain,proxyAddr){
                if(proxyAddr){
                    proxyRouter.proxyServeMap[browserId] = [header['page'],proxyAddr];
                }
                callback(proxyAddr);
            });
        }else {
            callback(this.proxyServeMap[browserId][1]);
        }
    }else{
        proxyRouter.__getProxyFromDb(domain,function(proxyAddr){
            callback(proxyAddr);
        });
    }
}
/**
 * get proxy from db, if possible get proxy from cache dictionary
 * @param callback
 * @private
 */
proxyRouter.prototype.__getProxyFromDb = function(domain,callback){
    var self = this;
    var proxyAddr;
    if(this.availableProxies[domain]){
        for(var k in this.availableProxies[domain]){
            if(this.availableProxies[domain].hasOwnProperty(k)){
                proxyAddr = k;
                logger.debug('get proxy '+k+' from cache '+domain);
                break;
            }
        }
    }
    if(proxyAddr)callback(proxyAddr);
    else{
        self.redis_cli3.lpop(PROXY_KEYS,function(err,ip){
            if(err)logger.error('Encountered error pop proxy from redis: '+err);
            else logger.debug('get proxy '+ip+' from redis ');
            callback(ip);
        });
    }
}
/**
 * vote proxy address, available or not
 * @param ip
 * @private
 */
proxyRouter.prototype.__voteProxy = function(domain,ip,score,callback){
    var self = this;
    if(!self.availableProxies[domain])self.availableProxies[domain] = {};
    if(score&&ip){
        if(self.availableProxies[domain][ip]){
            logger.debug('Vote '+ip+' available to cache, '+domain);
            if(callback)callback();
        }else {
            self.availableProxies[domain][ip] = true;
            self.redis_cli3.lpush(PROXY_KEYS,ip,function(err){
                if(err)logger.error('Encountered error vote proxy to redis');
                else logger.info('Vote '+ip+' available to redis, '+domain);
                if(callback)callback(err);
            });
        }
    }else{
        if(ip)delete self.availableProxies[domain][ip];
        logger.warn('Vote '+ip+' not available');
        if(callback)callback();
    }
}

/**
 * run proxy server daemon
 */
proxyRouter.prototype.proxyDaemon = function(){
    var proxyRouter = this;
    var httpProxyServer = http.createServer(function(request, response) {
        var startTime = (new Date()).getTime();
        var urlobj = url.parse(request.url);
        var domain = proxyRouter.__getTopLevelDomain(urlobj['hostname']);
        var httpCode;
        logger.info(util.format('Request %s from %s',request.url,request.socket.remoteAddress));
        //var proxy = http.createClient(80, request.headers['host']);
        //var proxy_request = proxy.request(request.method, request.url, request.headers);//202.171.253.98:80
        var route = true;
        proxyRouter.__chooseProxy(domain,request.socket.remoteAddress,request.headers,function(proxyAddr){
            if(route&&proxyAddr){
                var choseProxy = proxyAddr.split(':');
                var remoteProxyHost = choseProxy[0];
                var remoteProxyPort = choseProxy[1];
                var proxy_request = http.request({'host':remoteProxyHost,'port':remoteProxyPort,'method':request.method,'path':request.url,'headers':request.headers});
            }else{
                var proxy_request = http.request({'host':urlobj['host'],'port':urlobj['port'],'method':request.method,'path':request.url,'headers':request.headers});
            }
            //--proxy start---------------------------
            //proxy_request.setSocketKeepAlive(false);
            proxy_request.setTimeout(120000,function(){
                logger.error('Remote request timeout.');
                proxy_request.abort();
                response.end();
            });

            var timer_start = (new Date()).getTime();
            logger.debug(util.format('Request Forward to remote proxy server %s:%s',remoteProxyHost,remoteProxyPort));
            proxy_request.addListener('response', function (proxy_response) {
                httpCode = proxy_response.statusCode;
                proxy_response.addListener('data', function(chunk) {
                    //logger.debug('Write data to client');
                    if(!response.socket||response.socket.destroyed){
                        logger.error('client socket closed,oop!');
                        return response.end();
                    }
                    response.write(chunk, 'binary');
                });

                proxy_response.addListener('end', function() {
                    response.end();
                    if(httpCode<400)proxyRouter.__voteProxy(domain,proxyAddr,true);
                    logger.info(util.format('Write data to client(%s) finish, used proxy: %s, cost: %s ms',request.socket.remoteAddress,proxyAddr,(new Date()).getTime()-startTime));
                });

                proxy_response.headers['remoteproxy'] = util.format('%s:%d',remoteProxyHost,remoteProxyPort);
                response.writeHead(proxy_response.statusCode, proxy_response.headers);
                //response.write(util.format('<!--%s:%d-->',remoteProxyHost,remoteProxyPort), 'binary');
                logger.debug(util.format('Remote proxy response, %d, length: %s, cost: %dms',proxy_response.statusCode,proxy_response.headers['Content-Length'],(new Date()).getTime()-timer_start));
            });

            proxy_request.addListener('timeout', function() {
                proxyRouter.__voteProxy(domain,proxyAddr,false);
                response.end();
                logger.error('Remote proxy timeout ');
            });

            proxy_request.addListener('error', function(err,socket) {
                proxyRouter.__voteProxy(domain,proxyAddr,false);
                response.end();
                logger.error('Remote proxy error: '+err);
            });

            request.addListener('data', function(chunk) {
                logger.debug('Transfer data to remote proxy');
                if(!proxy_request.socket||proxy_request.socket.destroyed){
                    proxyRouter.__voteProxy(domain,proxyAddr,false);
                    logger.error('Remote socket closed,oop!');
                    return proxy_request.end();
                }
                proxy_request.write(chunk, 'binary');
            });

            request.addListener('end', function() {
                proxy_request.end();
                logger.debug('Transfer data to remote proxy finish');
            });

            request.addListener('close', function() {
                proxy_request.end();
                logger.error('Client closed');
            });
            //---proxy end--------------------------
        });
    });

    logger.debug(util.format('Http proxy server listen in %d',this.settings['port']));
    httpProxyServer.on('clientError',function(err,socket){
        logger.error(util.format('Client request error: %s',err));
    });

    httpProxyServer.on('error',function(err,socket){
        logger.error(util.format('Client request error: %s',err));
    });
    httpProxyServer.listen(this.settings['port']);
}
///////////////////////////////////////////////////////////////////////////////
module.exports = proxyRouter;