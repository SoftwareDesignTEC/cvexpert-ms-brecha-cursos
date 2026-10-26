export const invalidCourseQueries = [
    'page=0', 'page=-1', 'page=1.5', 'page=1e2', 'page=0x10', 'page=NaN', 'page=Infinity',
    'page=', 'page=%20', 'page=%201', 'page=%2B1', 'page=9007199254740992', 'page=' + '9'.repeat(400),
    'pageSize=0', 'pageSize=-1', 'pageSize=101', 'pageSize=2.5', 'pageSize=1e2', 'pageSize=',
    'platform=', 'platform=%20%09', 'platform=%00', 'skillName=', 'skillName=%0A',
    'isPaid=', 'isPaid=1', 'isPaid=0', 'isPaid=True', 'isPaid=FALSE', 'isPaid=null', 'isPaid=%20true',
    ...['page', 'pageSize', 'platform', 'isPaid', 'skillName'].flatMap(key => [
        `${key}=1&${key}=1`, `${key}[]=1`, `${key}[x]=1`, `${key}[__proto__][x]=1`,
    ]),
    'page=1&p%61ge=2',
];
