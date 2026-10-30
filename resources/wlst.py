# 由扩展生成的私密 Properties 文件传入数据；不从参数或环境读取口令。
import os
from java.lang import System, String
from java.util import Properties
from java.io import FileInputStream, File, FileOutputStream
from weblogic.security import UserConfigFileManager, UsernameAndPassword

data = Properties()
source = FileInputStream(INPUT_FILE)
try:
    data.load(source)
finally:
    source.close()
action = data['action']
if action == 'create':
    readTemplate(data['template'])
    cd('/Security/base_domain/User/weblogic')
    cmo.setName(data['username'])
    cmo.setPassword(data['password'])
    cd('/Server/AdminServer')
    cmo.setListenPort(int(data['port']))
    setOption('ServerStartMode', 'dev')
    setOption('OverwriteDomain', 'false')
    writeDomain(data['domainPath'])
    closeTemplate()
    security = os.path.join(data['domainPath'], 'servers', 'AdminServer', 'security')
    if not os.path.isdir(security):
        os.makedirs(security)
    boot = os.path.join(security, 'boot.properties')
    def property_value(value):
        # java.util.Properties 按 ISO-8859-1 读取，转义非 ASCII 和特殊字符。
        result = ''
        for c in value:
            if c in '\\ =:#!':
                result += '\\' + c
            elif ord(c) < 32 or ord(c) > 126:
                code = ord(c)
                if code > 65535:
                    code -= 65536
                    result += '\\u%04x\\u%04x' % (55296 + (code >> 10), 56320 + (code & 1023))
                else:
                    result += '\\u%04x' % code
            else:
                result += c
        return result
    bootFile = File(boot)
    created = bootFile.createNewFile()
    for allowed in (False, True):
        if not bootFile.setReadable(allowed, allowed) or not bootFile.setWritable(allowed, allowed):
            raise Exception('Cannot secure boot credentials')
    # 基础模板通常已生成加密 boot.properties；保留它，仅收紧权限。
    if created:
        target = FileOutputStream(bootFile)
        try:
            content = 'username=' + property_value(data['username']) + '\npassword=' + property_value(data['password']) + '\n'
            target.write(String(content).getBytes('ISO-8859-1'))
        finally:
            target.close()
if action in ('credentials', 'create'):
    # 离线登记时没有在线会话；使用 storeUserConfig 底层的官方加密文件 API。
    System.setProperty('weblogic.management.confirmKeyfileCreation', 'true')
    credentials = UsernameAndPassword(data['username'], String(data['password']).toCharArray())
    UserConfigFileManager.setUsernameAndPassword(credentials, data['userConfig'], data['userKey'], 'weblogic.management')
    credentials.dispose()
if action in ('stop', 'refresh'):
    connect(userConfigFile=data['userConfig'], userKeyFile=data['userKey'], url=data['url'])
    if action == 'stop':
        shutdown(data['adminName'], 'Server', ignoreSessions='true')
    else:
        storeUserConfig(data['userConfig'], data['userKey'], 'false')
        disconnect()
exit()
